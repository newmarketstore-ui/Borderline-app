// loyalty.earn：orders/paid → 按规则算分 → 写 earn 流水（幂等键 = 订单 GID）→ 排队同步 metafield。
// 优先用 webhook payload 算；payload 缺订单行时才调 Admin API 拉订单。
import type { WebhookEvent } from "@prisma/client";

import { computeEarnPoints } from "../lib/loyaltyMath";
import { normalizeOrderGraphql, normalizeOrderWebhook, type NormalizedOrder } from "../lib/shopifyPayload";
import {
  appendLedger,
  enrichLinesWithProductInfo,
  getAdminForShop,
  getLoyaltySettings,
  gql,
  markRedemptionsUsed,
  ORDER_FOR_EARN_QUERY,
  tierMultiplier,
  upsertMemberFromCustomer,
  type AdminGraphql,
} from "../models/loyalty.server";
import { enqueue, QUEUES } from "./queue.server";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleEarn(event: WebhookEvent): Promise<string | void> {
  const shop = event.shopDomain;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const payload = event.payload as Record<string, any>;
  const settings = await getLoyaltySettings(shop);

  let admin: AdminGraphql | null = null;
  const getAdmin = async () => (admin ??= await getAdminForShop(shop));

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
  if (!order.customer) return "skipped: no customer on order";

  // 订单用了积分兑换码 → 核销
  await markRedemptionsUsed(order.discountCodes, order.orderGid);

  // 有排除规则时才去补商品类型 / 标签
  const needsProductInfo =
    (settings.excludedProductTypes.length > 0 || settings.excludedTags.length > 0) &&
    order.earn.lines.some((l) => l.productId && l.productType === undefined);
  const lines = needsProductInfo ? await enrichLinesWithProductInfo(await getAdmin(), order.earn.lines) : order.earn.lines;

  const member = await upsertMemberFromCustomer(shop, order.customer, "order");
  const orderDate = order.processedAt ? new Date(order.processedAt) : new Date();
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
    },
  );
  if (result.points <= 0) return `skipped: 0 points (eligible ${result.eligibleCents} cents)`;

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
      },
    },
  });

  // metafield 同步单独排队（有自己的重试），不让它拖垮记账
  await enqueue(QUEUES.syncBalance, { shop, memberId: updated.id }, {}, 10_000);
  return applied ? undefined : "already applied (idempotent)";
}
