import { describe, expect, it } from "vitest";
import { normalizeOrderWebhook, normalizeRefundWebhook } from "./shopifyPayload";
import { computeEarnPoints } from "./loyaltyMath";

// 精简版 orders/paid payload（字段名与 Shopify REST webhook 一致，数值是编的）
const orderPaid = {
  id: 5550001,
  admin_graphql_api_id: "gid://shopify/Order/5550001",
  name: "#30001",
  test: false,
  taxes_included: false,
  processed_at: "2026-10-28T10:00:00-04:00",
  email: "order-email@example.com",
  discount_codes: [{ code: "BL-PTS-ABC", amount: "5.00", type: "fixed_amount" }],
  customer: { id: 777, admin_graphql_api_id: "gid://shopify/Customer/777", first_name: "Ada", last_name: "L" },
  line_items: [
    {
      id: 1,
      admin_graphql_api_id: "gid://shopify/LineItem/1",
      product_id: 42,
      gift_card: false,
      quantity: 2,
      price: "50.00",
      price_set: { shop_money: { amount: "50.00" } },
      discount_allocations: [{ amount: "5.00", amount_set: { shop_money: { amount: "5.00" } } }],
      tax_lines: [{ price: "11.70", price_set: { shop_money: { amount: "11.70" } } }],
    },
    { id: 2, product_id: null, gift_card: true, quantity: 1, price: "25.00", discount_allocations: [], tax_lines: [] },
  ],
  shipping_lines: [
    {
      price: "15.00",
      price_set: { shop_money: { amount: "15.00" } },
      discount_allocations: [],
      tax_lines: [{ price: "1.95", price_set: { shop_money: { amount: "1.95" } } }],
    },
  ],
};

describe("normalizeOrderWebhook", () => {
  it("maps REST line items, shipping, customer and codes", () => {
    const n = normalizeOrderWebhook(orderPaid)!;
    expect(n.orderGid).toBe("gid://shopify/Order/5550001");
    expect(n.customer).toEqual({
      gid: "gid://shopify/Customer/777",
      email: "order-email@example.com",
      phone: null,
      firstName: "Ada",
      lastName: "L",
    });
    expect(n.discountCodes).toEqual(["BL-PTS-ABC"]);
    expect(n.earn.lines[0]).toMatchObject({
      lineId: "gid://shopify/LineItem/1",
      productId: "gid://shopify/Product/42",
      unitPriceCents: 5000,
      discountCents: 500,
      taxCents: 1170,
    });
    expect(n.earn.lines[1].lineId).toBe("gid://shopify/LineItem/2");
    expect(n.earn.shippingCents).toBe(1500);
    expect(n.earn.shippingTaxCents).toBe(195);
    const r = computeEarnPoints(n.earn, {
      pointsPerDollar: 1,
      excludedProductTypes: [],
      excludedTags: [],
      earnOnShipping: false,
      earnOnTax: false,
      tierMultiplier: 1,
    });
    expect(r.points).toBe(95); // 2×50 − 5; gift card excluded
  });

  it("returns null when line items are missing (caller falls back to the API)", () => {
    expect(normalizeOrderWebhook({ id: 1 })).toBeNull();
  });

  it("treats orders without a customer as anonymous", () => {
    expect(normalizeOrderWebhook({ ...orderPaid, customer: null })!.customer).toBeNull();
  });
});

describe("normalizeRefundWebhook", () => {
  it("reads refund lines and shipping refunds from refund_shipping_lines", () => {
    const n = normalizeRefundWebhook({
      id: 900,
      order_id: 5550001,
      refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: "45.00", subtotal_set: { shop_money: { amount: "45.00" } } }],
      refund_shipping_lines: [{ subtotal_amount_set: { shop_money: { amount: "15.00" } } }],
    });
    expect(n).toEqual({
      refundGid: "gid://shopify/Refund/900",
      orderGid: "gid://shopify/Order/5550001",
      lines: [{ lineId: "gid://shopify/LineItem/1", quantity: 1, subtotalCents: 4500 }],
      shippingRefundCents: 1500,
    });
  });

  it("falls back to shipping_refund order adjustments (negative amounts)", () => {
    const n = normalizeRefundWebhook({
      id: 901,
      order_id: 1,
      refund_line_items: [],
      order_adjustments: [
        { kind: "shipping_refund", amount: "-15.00" },
        { kind: "refund_discrepancy", amount: "-3.00" },
      ],
    });
    expect(n.shippingRefundCents).toBe(1500);
  });
});
