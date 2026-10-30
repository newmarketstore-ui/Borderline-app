// 付费会员标签镜像：Member.tier = paid ⇔ 客户身上有 PAID_SYNC_TAG。
// 用途：Shopify 原生自动折扣按客户分群（customer_tags CONTAINS 'bl-paid-member'）给会员价（服务 5 折等），
// POS 加上客户就自动套用，不用店员手动找折扣。Appstle 的 gold-membership 标签以后卸载会没，所以我们自己维护一份。
import prisma from "../db.server";
import { isMember } from "../lib/membership";
import { getLoyaltySettings, gql, type AdminGraphql } from "./loyalty.server";

export const PAID_SYNC_TAG = process.env.PAID_MEMBER_TAG?.trim() || "bl-paid-member";

const TAGS_ADD = `#graphql
  mutation LoyaltyTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }`;
const TAGS_REMOVE = `#graphql
  mutation LoyaltyTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { message } }
  }`;

export type TagReconcileResult = "added" | "removed" | "unchanged" | "missing";

/** 把一个会员的标签对齐到 tier。幂等；tagsAdd / tagsRemove 本身也幂等。 */
export async function reconcilePaidTag(admin: AdminGraphql, memberId: string): Promise<TagReconcileResult> {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, shopifyCustomerId: true, tier: true, tags: true },
  });
  if (!m) return "missing";
  const desired = m.tier === "paid";
  const has = m.tags.includes(PAID_SYNC_TAG);
  if (desired === has) return "unchanged";
  const data = await gql<{
    tagsAdd?: { userErrors: Array<{ message: string }> };
    tagsRemove?: { userErrors: Array<{ message: string }> };
  }>(admin, desired ? TAGS_ADD : TAGS_REMOVE, { id: m.shopifyCustomerId, tags: [PAID_SYNC_TAG] });
  const errs = (desired ? data.tagsAdd : data.tagsRemove)?.userErrors ?? [];
  if (errs.length) throw new Error(`${desired ? "tagsAdd" : "tagsRemove"}: ${errs.map((e) => e.message).join("; ")}`);
  await prisma.member.update({
    where: { id: m.id },
    data: { tags: desired ? [...m.tags, PAID_SYNC_TAG] : m.tags.filter((t) => t !== PAID_SYNC_TAG) },
  });
  return desired ? "added" : "removed";
}

/**
 * sweep 用：① 付费档到期（paidUntil 过了且标签 / 合约都不再有效）→ 降回 standard；
 * ② 找 tier 与标签不一致的会员（含历史会员的首次补打）→ 返回要排队对齐的 memberId。每轮限量，避免一口气打几百个请求。
 */
export async function findPaidTagWork(now = new Date(), limit = 50): Promise<Array<{ shop: string; memberId: string }>> {
  const lapsed = await prisma.member.findMany({
    where: { tier: "paid", paidUntil: { lt: now } },
    include: { memberships: true },
    take: limit,
  });
  const settingsByShop = new Map<string, Awaited<ReturnType<typeof getLoyaltySettings>>>();
  for (const m of lapsed) {
    let s = settingsByShop.get(m.shopDomain);
    if (!s) settingsByShop.set(m.shopDomain, (s = await getLoyaltySettings(m.shopDomain)));
    const stillMember = isMember({ tags: m.tags.filter((t) => t !== PAID_SYNC_TAG), memberships: m.memberships }, now, s.memberTag);
    if (!stillMember) await prisma.member.update({ where: { id: m.id }, data: { tier: "standard", paidUntil: null } });
  }
  const [needAdd, needRemove] = await Promise.all([
    prisma.member.findMany({
      where: { tier: "paid", NOT: { tags: { has: PAID_SYNC_TAG } } },
      select: { id: true, shopDomain: true },
      take: limit,
    }),
    prisma.member.findMany({
      where: { tier: { not: "paid" }, tags: { has: PAID_SYNC_TAG } },
      select: { id: true, shopDomain: true },
      take: limit,
    }),
  ]);
  return [...needAdd, ...needRemove].slice(0, limit).map((m) => ({ shop: m.shopDomain, memberId: m.id }));
}
