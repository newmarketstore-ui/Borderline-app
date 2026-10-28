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
import { getMemberForGate, syncMembershipForCustomer, type MemberWithMemberships } from "../models/membership.server";
import { markRedemptionUsed } from "../models/redemption.server";
import { enqueue, QUEUES } from "./queue.server";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MEMBERSHIP_SYNC_DELAY_SECONDS = 120;

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

  // 会员门槛
  let membershipPurchase = false;
  let gateMember: MemberWithMemberships | null = await getMemberForGate(order.customer.gid);
  if (settings.earnRequiresMember) {
    if (!gateMember || !gateMember.membershipSyncedAt) {
      gateMember = await syncMembershipForCustomer(shop, await getAdmin(), order.customer.gid, {
        memberTag: settings.memberTag,
        createIfMember: true,
        source: "order",
      });
    } else if (order.customer.tags) {
      // payload 里的标签是下单时的最新值，先用它判断（customers/update 也会再同步）
      gateMember = { ...gateMember, tags: order.customer.tags };
    }
    const gate = earnGate(settings, gateMember, orderDate);
    if (!gate.eligible) {
      // 这一单就是买会员的：标签还没打上也按会员算，2 分钟后再同步会员资格
      if (!orderHasMembershipProduct(await withProductInfo())) {
        return `skipped: not a paying member (${gate.reason})${usedNote}`;
      }
      membershipPurchase = true;
      await deps.enqueueSyncMembership(shop, order.customer.gid, MEMBERSHIP_SYNC_DELAY_SECONDS);
    }
  }

  // 有排除规则时才去补商品类型 / 标签
  if (settings.excludedProductTypes.length > 0 || settings.excludedTags.length > 0) await withProductInfo();
  const membershipNote = membershipPurchase ? "membership purchase: earned as member, membership sync queued" : "";

  const member = await upsertMemberFromCustomer(shop, order.customer, "order");
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
      },
      ...(membershipPurchase ? { membershipPurchase: true } : {}),
    },
  });

  // metafield 同步单独排队（有自己的重试），不让它拖垮记账
  await deps.enqueueSyncBalance(shop, updated.id);
  const notes = [membershipNote, usedNote.slice(2)].filter(Boolean).join("; ");
  return applied ? notes || undefined : `already applied (idempotent)${notes ? `; ${notes}` : ""}`;
}
