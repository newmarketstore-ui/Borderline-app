// Shopify webhook（REST 形状）/ Admin GraphQL 订单 → 积分计算输入。纯函数，无 I/O。
// 金额一律取 shop_money（店铺币种 CAD），不用 presentment（顾客看到的币种）。
import { moneyToCents, type EarnLine, type EarnOrderInput, type RefundLineInput } from "./loyaltyMath";

type Money = string | number | null | undefined;
type RestMoneySet = { shop_money?: { amount?: Money } | null } | null | undefined;
type GqlMoneyBag = { shopMoney?: { amount?: Money } | null } | null | undefined;

/* eslint-disable @typescript-eslint/no-explicit-any -- webhook payload 是外部 JSON，这里集中做防御式读取 */
type Json = Record<string, any>;

const restCents = (set: RestMoneySet, fallback?: Money) => moneyToCents(set?.shop_money?.amount ?? fallback);
const gqlCents = (bag: GqlMoneyBag) => moneyToCents(bag?.shopMoney?.amount);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export const gid = (type: string, id: unknown) => {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/${type}/${s}`;
};

export type OrderCustomer = {
  gid: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
};

export type NormalizedOrder = {
  orderGid: string;
  orderName: string | null;
  test: boolean;
  processedAt: string | null;
  customer: OrderCustomer | null;
  discountCodes: string[];
  earn: EarnOrderInput;
};

export function customerFromRest(c: Json | null | undefined, fallbackEmail?: unknown): OrderCustomer | null {
  if (!c || (c.id === undefined && !c.admin_graphql_api_id)) return null;
  return {
    gid: str(c.admin_graphql_api_id) ?? gid("Customer", c.id),
    email: str(c.email) ?? str(fallbackEmail),
    phone: str(c.phone),
    firstName: str(c.first_name),
    lastName: str(c.last_name),
  };
}

/** orders/paid · orders/create webhook。没有 line_items 数组时返回 null（调用方改走 Admin API）。 */
export function normalizeOrderWebhook(p: Json): NormalizedOrder | null {
  if (!p || !Array.isArray(p.line_items)) return null;
  const lines: EarnLine[] = arr(p.line_items).map((li) => ({
    lineId: str(li.admin_graphql_api_id) ?? gid("LineItem", li.id),
    productId: li.product_id ? gid("Product", li.product_id) : null,
    productType: li.product_type ?? undefined, // REST 订单行一般不带，计分前按需用 Admin API 补
    tags: undefined,
    giftCard: Boolean(li.gift_card),
    quantity: Number(li.quantity) || 0,
    unitPriceCents: restCents(li.price_set, li.price),
    discountCents: arr(li.discount_allocations).reduce((s, d) => s + restCents(d.amount_set, d.amount), 0),
    taxCents: arr(li.tax_lines).reduce((s, t) => s + restCents(t.price_set, t.price), 0),
  }));
  const ship = arr(p.shipping_lines);
  return {
    orderGid: str(p.admin_graphql_api_id) ?? gid("Order", p.id),
    orderName: str(p.name),
    test: Boolean(p.test),
    processedAt: str(p.processed_at) ?? str(p.created_at),
    customer: customerFromRest(p.customer, p.email ?? p.contact_email),
    discountCodes: arr(p.discount_codes).map((d) => String(d.code ?? "")).filter(Boolean),
    earn: {
      lines,
      shippingCents: ship.reduce((s, l) => s + restCents(l.price_set, l.price), 0),
      shippingDiscountCents: ship.reduce(
        (s, l) => s + arr(l.discount_allocations).reduce((a, d) => a + restCents(d.amount_set, d.amount), 0),
        0,
      ),
      shippingTaxCents: ship.reduce(
        (s, l) => s + arr(l.tax_lines).reduce((a, t) => a + restCents(t.price_set, t.price), 0),
        0,
      ),
      taxesIncluded: Boolean(p.taxes_included),
    },
  };
}

/** Admin GraphQL `order(id:)`（查询见 app/models/loyalty.server.ts 的 ORDER_FOR_EARN_QUERY）。 */
export function normalizeOrderGraphql(o: Json): NormalizedOrder {
  const lines: EarnLine[] = arr(o.lineItems?.nodes).map((li) => ({
    lineId: String(li.id),
    productId: li.product?.id ?? null,
    productType: li.product?.productType ?? null,
    tags: arr(li.product?.tags).map(String),
    giftCard: Boolean(li.isGiftCard),
    quantity: Number(li.quantity) || 0,
    unitPriceCents: gqlCents(li.originalUnitPriceSet),
    discountCents: arr(li.discountAllocations).reduce((s, d) => s + gqlCents(d.allocatedAmountSet), 0),
    taxCents: arr(li.taxLines).reduce((s, t) => s + gqlCents(t.priceSet), 0),
  }));
  const ship = arr(o.shippingLines?.nodes);
  const c = o.customer as Json | null;
  return {
    orderGid: String(o.id),
    orderName: str(o.name),
    test: Boolean(o.test),
    processedAt: str(o.processedAt),
    customer: c
      ? {
          gid: String(c.id),
          email: str(c.defaultEmailAddress?.emailAddress) ?? str(o.email),
          phone: str(c.defaultPhoneNumber?.phoneNumber),
          firstName: str(c.firstName),
          lastName: str(c.lastName),
        }
      : null,
    discountCodes: arr(o.discountCodes).map(String),
    earn: {
      lines,
      shippingCents: ship.reduce((s, l) => s + gqlCents(l.originalPriceSet), 0),
      shippingDiscountCents: ship.reduce(
        (s, l) => s + arr(l.discountAllocations).reduce((a, d) => a + gqlCents(d.allocatedAmountSet), 0),
        0,
      ),
      shippingTaxCents: ship.reduce(
        (s, l) => s + arr(l.taxLines).reduce((a, t) => a + gqlCents(t.priceSet), 0),
        0,
      ),
      taxesIncluded: Boolean(o.taxesIncluded),
    },
  };
}

export type NormalizedRefund = {
  refundGid: string;
  orderGid: string;
  lines: RefundLineInput[];
  shippingRefundCents: number;
};

/** refunds/create webhook。 */
export function normalizeRefundWebhook(p: Json): NormalizedRefund {
  const lines: RefundLineInput[] = arr(p.refund_line_items).map((r) => ({
    lineId: str(r.line_item?.admin_graphql_api_id) ?? gid("LineItem", r.line_item_id),
    quantity: Number(r.quantity) || 0,
    subtotalCents: restCents(r.subtotal_set, r.subtotal),
  }));
  // 新版 payload 有 refund_shipping_lines；老版本运费退款记在 order_adjustments(kind = shipping_refund，金额为负)
  const shipLines = arr(p.refund_shipping_lines);
  const shippingRefundCents = shipLines.length
    ? shipLines.reduce((s, l) => s + restCents(l.subtotal_amount_set), 0)
    : arr(p.order_adjustments)
        .filter((a) => a.kind === "shipping_refund")
        .reduce((s, a) => s + Math.abs(restCents(a.amount_set, a.amount)), 0);
  return {
    refundGid: str(p.admin_graphql_api_id) ?? gid("Refund", p.id),
    orderGid: gid("Order", p.order_id),
    lines,
    shippingRefundCents,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
