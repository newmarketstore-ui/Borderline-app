import { describe, expect, it } from "vitest";
import {
  computeEarnPoints,
  computeRefundReversal,
  moneyToCents,
  pointsForCents,
  redeemValueCents,
  refundedEligibleCents,
  validateRedeemPoints,
  type EarnLine,
  type EarnOrderInput,
  type EarnRules,
} from "./loyaltyMath";

const rules = (over: Partial<EarnRules> = {}): EarnRules => ({
  pointsPerDollar: 1,
  excludedProductTypes: [],
  excludedTags: [],
  earnOnShipping: false,
  earnOnTax: false,
  tierMultiplier: 1,
  ...over,
});

const line = (over: Partial<EarnLine> = {}): EarnLine => ({
  lineId: "gid://shopify/LineItem/1",
  productType: "Snowboard",
  tags: [],
  giftCard: false,
  quantity: 1,
  unitPriceCents: 10000,
  discountCents: 0,
  taxCents: 1300,
  ...over,
});

const order = (lines: EarnLine[], over: Partial<EarnOrderInput> = {}): EarnOrderInput => ({
  lines,
  shippingCents: 0,
  shippingDiscountCents: 0,
  shippingTaxCents: 0,
  taxesIncluded: false,
  ...over,
});

describe("moneyToCents", () => {
  it("parses decimal strings without float error", () => {
    expect(moneyToCents("12.34")).toBe(1234);
    expect(moneyToCents("0.1")).toBe(10);
    expect(moneyToCents("1099")).toBe(109900);
    expect(moneyToCents("-5.5")).toBe(-550);
    expect(moneyToCents(19.99)).toBe(1999);
    expect(moneyToCents(null)).toBe(0);
    expect(moneyToCents("abc")).toBe(0);
  });
});

describe("pointsForCents (floor to whole points)", () => {
  it("floors partial dollars", () => {
    expect(pointsForCents(1099, 1)).toBe(10);
    expect(pointsForCents(99, 1)).toBe(0);
    expect(pointsForCents(999, 1.5)).toBe(14); // 14.985 → 14
  });
  it("is exact where floats are not", () => {
    // 10 dollars at 0.3 pts/$ must be exactly 3 (float math gives 2.9999…)
    expect(pointsForCents(1000, 0.3)).toBe(3);
    expect(pointsForCents(30000, 1.1)).toBe(330);
  });
  it("returns 0 for non-positive amounts", () => {
    expect(pointsForCents(0, 1)).toBe(0);
    expect(pointsForCents(-500, 1)).toBe(0);
  });
});

describe("computeEarnPoints", () => {
  it("earns on discounted pre-tax goods by default", () => {
    const r = computeEarnPoints(order([line({ quantity: 2, unitPriceCents: 5099, discountCents: 1000 })]), rules());
    expect(r.goodsCents).toBe(9198);
    expect(r.points).toBe(91);
  });

  it("excludes gift cards always", () => {
    const r = computeEarnPoints(order([line({ giftCard: true }), line({ lineId: "b", unitPriceCents: 2000 })]), rules());
    expect(r.lines[0].excluded).toBe("gift_card");
    expect(r.points).toBe(20);
  });

  it("excludes configured product types and tags case-insensitively", () => {
    const r = computeEarnPoints(
      order([
        line({ lineId: "a", productType: "Service" }),
        line({ lineId: "b", tags: ["No-Points"] }),
        line({ lineId: "c", unitPriceCents: 4000 }),
      ]),
      rules({ excludedProductTypes: [" service "], excludedTags: ["no-points"] }),
    );
    expect(r.lines.map((l) => l.excluded)).toEqual(["product_type", "tag", null]);
    expect(r.eligibleCents).toBe(4000);
    expect(r.points).toBe(40);
  });

  it("adds shipping and tax only when configured", () => {
    const o = order([line()], { shippingCents: 1500, shippingDiscountCents: 500, shippingTaxCents: 130 });
    expect(computeEarnPoints(o, rules()).points).toBe(100);
    expect(computeEarnPoints(o, rules({ earnOnShipping: true })).points).toBe(110);
    expect(computeEarnPoints(o, rules({ earnOnTax: true })).points).toBe(113);
    // 100 + 13 tax + 10 shipping + 1.30 shipping tax = 124.30
    expect(computeEarnPoints(o, rules({ earnOnShipping: true, earnOnTax: true })).points).toBe(124);
  });

  it("strips tax from tax-inclusive prices when not earning on tax", () => {
    const o = order([line({ unitPriceCents: 11300, taxCents: 1300 })], { taxesIncluded: true });
    expect(computeEarnPoints(o, rules()).points).toBe(100);
    expect(computeEarnPoints(o, rules({ earnOnTax: true })).points).toBe(113);
  });

  it("applies the tier multiplier before flooring", () => {
    const o = order([line({ unitPriceCents: 3333 })]);
    expect(computeEarnPoints(o, rules()).points).toBe(33);
    expect(computeEarnPoints(o, rules({ tierMultiplier: 1.5 })).points).toBe(49); // 49.995 → 49
    expect(computeEarnPoints(o, rules({ tierMultiplier: 2, pointsPerDollar: 1.25 })).points).toBe(83); // 83.325
  });

  it("never goes negative when discounts exceed price", () => {
    const r = computeEarnPoints(order([line({ discountCents: 20000 })]), rules());
    expect(r.points).toBe(0);
    expect(r.eligibleCents).toBe(0);
  });
});

describe("refund reversal (proportional to refunded subtotal)", () => {
  const earned = computeEarnPoints(
    order([
      line({ lineId: "A", quantity: 2, unitPriceCents: 5000 }), // net 10000
      line({ lineId: "G", giftCard: true, unitPriceCents: 5000 }),
    ]),
    rules(),
  );

  it("sanity: earned 100 points on 10000 eligible cents", () => {
    expect(earned.points).toBe(100);
    expect(earned.eligibleCents).toBe(10000);
  });

  it("reverses half for half the line refunded", () => {
    const r = computeRefundReversal({
      earnedPoints: 100,
      earn: earned,
      refund: { lines: [{ lineId: "A", quantity: 1, subtotalCents: 5000 }], shippingRefundCents: 0 },
      alreadyRefundedEligibleCents: 0,
      alreadyReversedPoints: 0,
    });
    expect(r.refundedEligibleCents).toBe(5000);
    expect(r.pointsToReverse).toBe(50);
  });

  it("uses cumulative math so two partial refunds reverse exactly what was earned", () => {
    const earn99 = computeEarnPoints(order([line({ lineId: "A", quantity: 2, unitPriceCents: 4999 })]), rules());
    expect(earn99.points).toBe(99);
    const first = computeRefundReversal({
      earnedPoints: 99,
      earn: earn99,
      refund: { lines: [{ lineId: "A", quantity: 1, subtotalCents: 4999 }], shippingRefundCents: 0 },
      alreadyRefundedEligibleCents: 0,
      alreadyReversedPoints: 0,
    });
    expect(first.pointsToReverse).toBe(49); // floor(49.5)
    const second = computeRefundReversal({
      earnedPoints: 99,
      earn: earn99,
      refund: { lines: [{ lineId: "A", quantity: 1, subtotalCents: 4999 }], shippingRefundCents: 0 },
      alreadyRefundedEligibleCents: first.cumulativeRefundedEligibleCents,
      alreadyReversedPoints: first.pointsToReverse,
    });
    expect(first.pointsToReverse + second.pointsToReverse).toBe(99);
  });

  it("ignores refunds of excluded lines and unknown lines", () => {
    const r = refundedEligibleCents(earned, {
      lines: [
        { lineId: "G", quantity: 1, subtotalCents: 5000 },
        { lineId: "ZZZ", quantity: 1, subtotalCents: 999 },
      ],
      shippingRefundCents: 0,
    });
    expect(r).toBe(0);
  });

  it("caps at the earned amount even if refund exceeds it", () => {
    const r = computeRefundReversal({
      earnedPoints: 100,
      earn: earned,
      refund: { lines: [{ lineId: "A", quantity: 2, subtotalCents: 999999 }], shippingRefundCents: 0 },
      alreadyRefundedEligibleCents: 0,
      alreadyReversedPoints: 0,
    });
    expect(r.pointsToReverse).toBe(100);
  });

  it("only counts shipping refunds when shipping earned points", () => {
    const withShip = computeEarnPoints(
      order([line({ lineId: "A" })], { shippingCents: 2000 }),
      rules({ earnOnShipping: true }),
    );
    expect(withShip.points).toBe(120);
    const r = computeRefundReversal({
      earnedPoints: withShip.points,
      earn: withShip,
      refund: { lines: [], shippingRefundCents: 2000 },
      alreadyRefundedEligibleCents: 0,
      alreadyReversedPoints: 0,
    });
    expect(r.pointsToReverse).toBe(20);
    expect(refundedEligibleCents(earned, { lines: [], shippingRefundCents: 2000 })).toBe(0);
  });

  it("reverses nothing when nothing was earned", () => {
    const r = computeRefundReversal({
      earnedPoints: 0,
      earn: { eligibleCents: 0, shippingCents: 0, lines: [] },
      refund: { lines: [{ lineId: "A", quantity: 1, subtotalCents: 100 }], shippingRefundCents: 0 },
      alreadyRefundedEligibleCents: 0,
      alreadyReversedPoints: 0,
    });
    expect(r.pointsToReverse).toBe(0);
  });
});

describe("redeem helpers", () => {
  const rr = { redeemPointsPerDollar: 100, minRedeemPoints: 500, redeemStepPoints: 100 };
  it("converts points to cents", () => {
    expect(redeemValueCents(500, rr)).toBe(500);
    expect(redeemValueCents(150, { ...rr, redeemPointsPerDollar: 200 })).toBe(75);
  });
  it("validates min, step and balance", () => {
    expect(validateRedeemPoints(400, 1000, rr).ok).toBe(false);
    expect(validateRedeemPoints(550, 1000, rr).ok).toBe(false);
    expect(validateRedeemPoints(1100, 1000, rr).ok).toBe(false);
    expect(validateRedeemPoints(600, 1000, rr).ok).toBe(true);
  });
});
