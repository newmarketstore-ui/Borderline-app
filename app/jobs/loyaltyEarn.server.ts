// loyalty.earn：orders/paid → 核销积分码 → 会员门槛 → 按规则算分 → 写 earn 流水（幂等键 = 订单 GID）→ 排队同步 metafield。
// 优先用 webhook payload 算；payload 缺订单行时才调 Admin API 拉订单。
// 会员门槛（LoyaltyConfig.earnRequiresMember，默认开）：只有付费会员赚分。
//   会员身份未知（没有 Member 行或从没同步过）→ 当场用 Admin API 拉标签 + appstle_membership.subscriptions 再判断。
//   买会员的那一单：orders/paid 可能比 Appstle 打 gold-membership 标签先到。判断下来不是会员、但订单里有标签
//   Membership 的商品 → 这一单按会员给分，同时排一个 2 分钟后的 loyalty.sync_membership 把会员资格补上。
import type { WebhookEvent } from "@prisma/client";

import { computeEarnPoints } from "../lib/loyaltyMath";
import { earnGate, orderHasMembershipProduct } from "../lib/membership";
import { normalizeOrderGraphql, normalizeOrderWebhook, type NormalizedOrder } from "../lib/shopifyPayload";
import {
  appendLedger,
  enrichLinesWithProductInfo,
  getAdminForShop,
  getLoyaltySettings,
  gql,
  ORDER_FOR_EARN_QUERY,
  tierMultiplier,
  upsertMemberFromCustomer,
  type AdminGraphql,
} from "../models/loyalty.server";
import {
  getMemberForGate,
  grantPurchasedMembership,
  syncMembershipForCustomer,
  type MemberWithMemberships,
} from "../models/membership.server";
import { markRedemptionUsed } from "../models/redemption.server";
import { enqueue, QUEUES } from "./queue.server";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MEMBERSHIP_SYNC_DELAY_SECONDS = 120;
/** 会员资格快照超过这么久就重新从 Shopify 拉一次（付费会员到期 / 续费都靠这个 + customers/update 兜底） */
export const MEMBERSHIP_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type EarnDeps = {
  getAdmin: (shop: string) => Promise<AdminGraphql>;
  enqueueSyncBalance: (shop: string, memberId: string) => Promise<unknown>;
  enqueueSyncMembership: (shop: string, customerGid: string, delaySeconds: number) => Promise<unknown>;
};

export const defaultEarnDeps: EarnDeps = {
  getAdmin: getAdminForShop,
  enqueueSyncBalance: (shop, memberId) => enqueue(QUEUES.syncBalance, { shop, memberId }, {}, 10_000),
  enqueueSyncMembership: (shop, customerGid, delaySeconds) =>
    enqueue(QUEUES.syncMembership, { shop, customerGid }, { startAfter: delaySeconds }, 10_000),
};

export async function handleEarn(event: WebhookEvent, deps: EarnDeps = defaultEarnDeps): Promise<string | void> {
  const shop = event.shopDomain;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const payload = event.payload as Record<string, any>;
  const settings = await getLoyaltySettings(shop);

  let admin: AdminGraphql | null = null;
  const getAdmin = async () => (admin ??= await deps.getAdmin(shop));

  let order: NormalizedOrder | null = normalizeOrderWebhook(payload);
  if (!order) {
    const orderGid = String(payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`);
    const data = await gql<{ order: Record<string, unknown> | null }>(await getAdmin(), ORDER_FOR_EARN_QUERY, {
      id: orderGid,
    });
    if (!data.order) return `skipped: order ${orderGid} not found via Admin API`;
    order = normalizeOrderGraphql(data.order);
  }

  if (order.test) return "skipped: test order";

  // 订单用了积分兑换码 → 核销（不管顾客是不是会员、这单赚不赚分）
  const usage = await markRedemptionUsed(order);
  const usedNote = usage.used ? `; ${usage.used} redemption(s) marked used` : "";

  if (!order.customer) return `skipped: no customer on order${usedNote}`;
  const orderDate = order.processedAt ? new Date(order.processedAt) : new Date();

  // 商品类型 / 标签：REST 订单行不带，按需用 Admin API 补一次（排除规则、会员商品判断共用）
  let lines = order.earn.lines;
  let enriched = false;
  const withProductInfo = async () => {
    if (!enriched && lines.some((l) => l.productId && (l.productType === undefined || l.tags === undefined))) {
      lines = await enrichLinesWithProductInfo(await getAdmin(), lines);
    }
    enriched = true;
    return lines;
  };

  // 会员身份：不管赚分要不要会员，都要知道是不是付费会员（付费会员按 paidTierMultiplier 倍数赚）
  const knownBefore: MemberWithMemberships | null = await getMemberForGate(order.customer.gid);
  let gateMember = knownBefore;
  const syncedAt = gateMember?.membershipSyncedAt?.getTime() ?? 0;
  if (!gateMember || Date.now() - syncedAt > MEMBERSHIP_SYNC_MAX_AGE_MS) {
    const synced = await syncMembershipForCustomer(shop, await getAdmin(), order.customer.gid, {
      memberTag: settings.memberTag,
      createIfMember: true,
      source: "order",
    });
    if (synced) gateMember = synced;
  } else if (order.customer.tags) {
    // payload 里的标签是下单时的最新值，先用它判断（customers/update 也会再同步）
    gateMember = { ...gateMember, tags: order.customer.tags };
  }

  // 这一单买了会员商品（标签 Membership）→ 自己记一份付费会员，本单就按付费会员算
  // 只有行标题像会员商品、或配置了排除规则时才去 Admin API 补商品标签（省一次调用）
  const titleHint = new RegExp(settings.membershipProductTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const maybeMembership = lines.some((l) => (l.tags ?? []).length > 0 || titleHint.test(l.title ?? ""));
  if (maybeMembership || settings.excludedProductTypes.length > 0 || settings.excludedTags.length > 0) await withProductInfo();
  const membershipPurchase = orderHasMembershipProduct(lines, settings.membershipProductTag);

  if (settings.earnRequiresMember && !membershipPurchase) {
    const gate = earnGate(settings, gateMember, orderDate);
    if (!gate.eligible) return `skipped: not a paying member (${gate.reason})${usedNote}`;
  }

  let member = await upsertMemberFromCustomer(shop, order.customer, "order");
  const notes: string[] = [];

  // 首次建档送分（规则 0 = 不送）；幂等键 signup:<客户 GID>
  if (!knownBefore && settings.signupBonusPoints > 0) {
    const bonus = await appendLedger({
      memberId: member.id,
      delta: settings.signupBonusPoints,
      type: "signup_bonus",
      referenceType: "customer",
      referenceId: `signup:${order.customer.gid}`,
      note: "Welcome bonus",
      createdBy: "system",
    });
    if (bonus.applied) notes.push(`signup bonus ${settings.signupBonusPoints}`);
  }

  if (membershipPurchase) {
    member = await grantPurchasedMembership({
      memberId: member.id,
      orderGid: order.orderGid,
      orderName: order.orderName,
      months: settings.membershipMonths,
      at: orderDate,
    });
    // Appstle Memberships 还在用时它也会打标签 / 建合约，2 分钟后再同步一次拿它的到期日
    await deps.enqueueSyncMembership(shop, order.customer.gid, MEMBERSHIP_SYNC_DELAY_SECONDS);
    notes.push("membership purchase: paid tier granted");
  }
  const membershipNote = notes.join("; ");
  const multiplier = tierMultiplier(member, settings, orderDate);

  const result = computeEarnPoints(
    { ...order.earn, lines },
    {
      pointsPerDollar: settings.pointsPerDollar,
      excludedProductTypes: settings.excludedProductTypes,
      excludedTags: settings.excludedTags,
      earnOnShipping: settings.earnOnShipping,
      earnOnTax: settings.earnOnTax,
      tierMultiplier: multiplier,
      excludeDiscountedItems: settings.excludeDiscountedItems,
    },
  );
  if (result.points <= 0) {
    return `skipped: 0 points (eligible ${result.eligibleCents} cents)${usedNote}${membershipNote ? `; ${membershipNote}` : ""}`;
  }

  const { applied, member: updated } = await appendLedger({
    memberId: member.id,
    delta: result.points,
    type: "earn",
    referenceType: "order",
    referenceId: order.orderGid,
    orderId: order.orderGid,
    orderName: order.orderName,
    availableAt: settings.pendingDays > 0 ? new Date(Date.now() + settings.pendingDays * DAY_MS) : new Date(),
    createdBy: "system",
    // 退款按比例扣回要用这些明细；同时留下当时的规则快照，规则以后改了也能对账
    meta: {
      eligibleCents: result.eligibleCents,
      goodsCents: result.goodsCents,
      shippingCents: result.shippingCents,
      taxCents: result.taxCents,
      lines: result.lines,
      rules: {
        pointsPerDollar: settings.pointsPerDollar,
        tierMultiplier: multiplier,
        earnOnShipping: settings.earnOnShipping,
        earnOnTax: settings.earnOnTax,
        excludedProductTypes: settings.excludedProductTypes,
        excludedTags: settings.excludedTags,
        excludeDiscountedItems: settings.excludeDiscountedItems,
        earnRequiresMember: settings.earnRequiresMember,
        memberTag: settings.memberTag,
        tier: member.tier,
        paidUntil: member.paidUntil?.toISOString() ?? null,
      },
      ...(membershipPurchase ? { membershipPurchase: true } : {}),
    },
  });

  // metafield 同步单独排队（有自己的重试），不让它拖垮记账
  await deps.enqueueSyncBalance(shop, updated.id);
  const finalNotes = [membershipNote, usedNote.slice(2)].filter(Boolean).join("; ");
  return applied ? finalNotes || undefined : `already applied (idempotent)${finalNotes ? `; ${finalNotes}` : ""}`;
}
