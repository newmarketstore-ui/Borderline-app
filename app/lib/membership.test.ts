import { describe, expect, it } from "vitest";
import { earnGate, hasMemberTag, isMember, paidUntilFrom, parseAppstleSubscriptions, parseTagList } from "./membership";
import { computeEarnPoints, type EarnLine } from "./loyaltyMath";

const NOW = new Date("2026-10-28T12:00:00Z");

describe("isMember", () => {
  it("tag alone makes a member (case-insensitive)", () => {
    expect(isMember({ tags: ["Gold", "Gold-Membership "] }, NOW)).toBe(true);
    expect(hasMemberTag(["Gold membership"], "gold-membership")).toBe(false);
    expect(isMember({ tags: ["vip"] }, NOW, "vip")).toBe(true);
  });
  it("an active membership without the tag counts", () => {
    expect(isMember({ tags: [], memberships: [{ status: "active", endsAt: null }] }, NOW)).toBe(true);
  });
  it("cancelled / expired / past endsAt do not count", () => {
    expect(isMember({ tags: [], memberships: [{ status: "cancelled" }] }, NOW)).toBe(false);
    expect(isMember({ tags: [], memberships: [{ status: "expired" }] }, NOW)).toBe(false);
    expect(isMember({ tags: [], memberships: [{ status: "active", endsAt: "2026-10-01T00:00:00Z" }] }, NOW)).toBe(false);
    expect(isMember({ tags: [], memberships: [{ status: "active", endsAt: "2027-10-01T00:00:00Z" }] }, NOW)).toBe(true);
    expect(isMember({}, NOW)).toBe(false);
  });
});

describe("parseAppstleSubscriptions", () => {
  const value = JSON.stringify([
    {
      id: 28958687487,
      sellingPlanIds: [8600813823],
      sellingPlanNames: ["Annual Membership"],
      variantNames: ["Store Membership"],
      status: "active",
      membershipStartDate: "2025-03-29T18:48:57Z",
      nextBillingDate: "2027-03-29T18:00:00Z",
      billingCyclesCompleted: 1,
    },
    { id: 31355633919, sellingPlanNames: [], membershipTier: "Borderline Outdoor Store Membership", status: "CANCELLED" },
    { id: 1, status: "paused" },
    { status: "active" },
  ]);
  it("maps contract id, plan, status and dates", () => {
    const m = parseAppstleSubscriptions(value);
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({
      source: "appstle",
      externalId: "28958687487",
      planName: "Annual Membership",
      status: "active",
    });
    expect(m[0].startedAt?.toISOString()).toBe("2025-03-29T18:48:57.000Z");
    expect(m[0].renewsAt?.toISOString()).toBe("2027-03-29T18:00:00.000Z");
    expect(m[1]).toMatchObject({ planName: "Borderline Outdoor Store Membership", status: "cancelled" });
    expect(m[2].status).toBe("expired");
    expect(paidUntilFrom(m, NOW)?.toISOString()).toBe("2027-03-29T18:00:00.000Z");
  });
  it("tolerates junk", () => {
    expect(parseAppstleSubscriptions("not json")).toEqual([]);
    expect(parseAppstleSubscriptions(null)).toEqual([]);
    expect(parseAppstleSubscriptions({ id: 1 })).toEqual([]);
  });
  it("parses REST tag strings", () => {
    expect(parseTagList("Gold, gold-membership,  , Gold")).toEqual(["Gold", "gold-membership"]);
    expect(parseTagList("a|b", /\|/)).toEqual(["a", "b"]);
  });
});

describe("member-only earn rules (Appstle defaults)", () => {
  const line = (over: Partial<EarnLine>): EarnLine => ({
    lineId: "gid://shopify/LineItem/1",
    productType: "Jacket",
    tags: [],
    giftCard: false,
    quantity: 1,
    unitPriceCents: 10000,
    discountCents: 0,
    taxCents: 1300,
    ...over,
  });
  const order = (lines: EarnLine[]) => ({
    lines,
    shippingCents: 1500,
    shippingDiscountCents: 0,
    shippingTaxCents: 195,
    taxesIncluded: false,
  });
  const rules = {
    pointsPerDollar: 1,
    excludedProductTypes: [],
    excludedTags: ["Gift Card", "Service"],
    earnOnShipping: false,
    earnOnTax: false,
    tierMultiplier: 1,
    excludeDiscountedItems: true,
  };
  it("1 pt per $1 of subtotal, no tax / shipping, discounted and Service lines excluded, floored", () => {
    const r = computeEarnPoints(
      order([
        line({ lineId: "a", unitPriceCents: 12999 }),
        line({ lineId: "b", discountCents: 500 }),
        line({ lineId: "c", tags: ["service"] }),
        line({ lineId: "d", tags: ["Gift Card"], giftCard: false }),
      ]),
      rules,
    );
    expect(r.points).toBe(129);
    expect(r.lines.map((l) => l.excluded)).toEqual([null, "discounted", "tag", "tag"]);
  });
  it("discounted lines earn when excludeDiscountedItems is off", () => {
    const r = computeEarnPoints(order([line({ discountCents: 500 })]), { ...rules, excludeDiscountedItems: false });
    expect(r.points).toBe(95);
  });
});

describe("earnGate", () => {
  const on = { earnRequiresMember: true, memberTag: "gold-membership" };
  it("only members earn when the rule is on", () => {
    expect(earnGate(on, { tags: ["gold-membership"] }, NOW)).toEqual({ eligible: true, reason: "member" });
    expect(earnGate(on, { tags: ["Gold"] }, NOW)).toEqual({ eligible: false, reason: "not_member" });
    expect(earnGate(on, { tags: [], memberships: [{ status: "active" }] }, NOW).eligible).toBe(true);
    expect(earnGate(on, null, NOW)).toEqual({ eligible: false, reason: "unknown" });
  });
  it("everyone earns when the rule is off", () => {
    expect(earnGate({ ...on, earnRequiresMember: false }, null, NOW)).toEqual({ eligible: true, reason: "rule_off" });
  });
});
