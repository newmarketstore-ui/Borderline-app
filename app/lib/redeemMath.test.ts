import { describe, expect, it } from "vitest";
import {
  activeWindow,
  localDayHour,
  quoteRedemption,
  redeemAmountCents,
  redeemPointOptions,
  type RedeemQuoteRules,
  type RedeemWindowRule,
} from "./redeemMath";

const rules = (over: Partial<RedeemQuoteRules> = {}): RedeemQuoteRules => ({
  redeemPointsPerDollar: 10,
  minRedeemPoints: 500,
  redeemStepPoints: 100,
  redeemAmountIsTaxInclusive: true,
  assumedTaxRate: 0.13,
  redeemRounding: "nearest_cent",
  redeemRequiresMember: true,
  ...over,
});

const wednesday: RedeemWindowRule = {
  id: "w1",
  label: "Double Redeem Wednesday",
  dayOfWeek: 3,
  startHour: null,
  endHour: null,
  timezone: "America/Toronto",
  multiplier: 2,
  channels: ["pos"],
  memberOnly: true,
  active: true,
};

// 2026-10-28 是周三；多伦多 10 月是 EDT (UTC-4)，11/1 起 EST (UTC-5)
const TUE_2359_EDT = new Date("2026-10-28T03:59:59Z");
const WED_0000_EDT = new Date("2026-10-28T04:00:00Z");
const WED_2359_EDT = new Date("2026-10-29T03:59:59Z");
const THU_0000_EDT = new Date("2026-10-29T04:00:00Z");

describe("tax gross-up (10 pts = $1 tax-inclusive)", () => {
  it("500 pts → $44.25 pre-tax with nearest-cent rounding", () => {
    expect(redeemAmountCents(500, 1, rules())).toEqual({ faceValueCents: 5000, amountCents: 4425 });
  });
  it("matches Appstle's hand-typed 44.30 / 88.50 with up_10_cents", () => {
    expect(redeemAmountCents(500, 1, rules({ redeemRounding: "up_10_cents" })).amountCents).toBe(4430);
    expect(redeemAmountCents(1000, 1, rules({ redeemRounding: "up_10_cents" })).amountCents).toBe(8850);
  });
  it("floor_cent rounds down", () => {
    expect(redeemAmountCents(500, 1, rules({ redeemRounding: "floor_cent" })).amountCents).toBe(4424);
  });
  it("no gross-up when the amount is not tax-inclusive", () => {
    expect(redeemAmountCents(500, 1, rules({ redeemAmountIsTaxInclusive: false })).amountCents).toBe(5000);
  });
  it("rounds once after applying the multiplier (no double rounding)", () => {
    // 500 × 2 / 10 / 1.13 = 88.4956 → 88.50（先各自取整会得到 2 × 44.25 = 88.50，这里结果一致但走的是一次取整）
    expect(redeemAmountCents(500, 2, rules()).amountCents).toBe(8850);
    // 700 × 2 = 1400 → 123.893… → 123.89；分开取整 2 × 61.95 = 123.90 会多 1 分
    expect(redeemAmountCents(700, 2, rules()).amountCents).toBe(12389);
  });
});

describe("Wednesday window in America/Toronto", () => {
  it("reads local weekday / hour", () => {
    expect(localDayHour(WED_0000_EDT, "America/Toronto")).toEqual({ dayOfWeek: 3, hour: 0 });
    expect(localDayHour(TUE_2359_EDT, "America/Toronto")).toEqual({ dayOfWeek: 2, hour: 23 });
  });
  it("starts at local midnight and ends before Thursday", () => {
    const ctx = { channel: "pos" as const, isMember: true };
    expect(activeWindow([wednesday], { ...ctx, at: TUE_2359_EDT })).toBeNull();
    expect(activeWindow([wednesday], { ...ctx, at: WED_0000_EDT })?.id).toBe("w1");
    expect(activeWindow([wednesday], { ...ctx, at: WED_2359_EDT })?.id).toBe("w1");
    expect(activeWindow([wednesday], { ...ctx, at: THU_0000_EDT })).toBeNull();
  });
  it("follows the EST switch (UTC-5 after Nov 1)", () => {
    const ctx = { channel: "pos" as const, isMember: true };
    expect(activeWindow([wednesday], { ...ctx, at: new Date("2026-11-04T04:59:59Z") })).toBeNull();
    expect(activeWindow([wednesday], { ...ctx, at: new Date("2026-11-04T05:00:00Z") })?.id).toBe("w1");
  });
  it("respects channel, memberOnly, active and hour range", () => {
    expect(activeWindow([wednesday], { at: WED_0000_EDT, channel: "web", isMember: true })).toBeNull();
    expect(activeWindow([wednesday], { at: WED_0000_EDT, channel: "pos", isMember: false })).toBeNull();
    expect(activeWindow([{ ...wednesday, active: false }], { at: WED_0000_EDT, channel: "pos", isMember: true })).toBeNull();
    const evening = { ...wednesday, startHour: 17, endHour: 21 };
    const at1659 = new Date("2026-10-28T20:59:00Z"); // 16:59 EDT
    const at1700 = new Date("2026-10-28T21:00:00Z"); // 17:00 EDT
    const at2100 = new Date("2026-10-29T01:00:00Z"); // 21:00 EDT
    expect(activeWindow([evening], { at: at1659, channel: "pos", isMember: true })).toBeNull();
    expect(activeWindow([evening], { at: at1700, channel: "pos", isMember: true })).not.toBeNull();
    expect(activeWindow([evening], { at: at2100, channel: "pos", isMember: true })).toBeNull();
  });
  it("picks the biggest multiplier when several match", () => {
    const triple = { ...wednesday, id: "w3", multiplier: 3, channels: [] };
    expect(activeWindow([wednesday, triple], { at: WED_0000_EDT, channel: "pos", isMember: true })?.id).toBe("w3");
  });
});

describe("quoteRedemption", () => {
  const base = { points: 500, channel: "pos" as const, at: WED_0000_EDT, isMember: true, balance: 1000 };
  it("applies the Wednesday ×2 at POS", () => {
    const q = quoteRedemption(base, rules(), [wednesday]);
    expect(q.ok).toBe(true);
    expect(q.multiplier).toBe(2);
    expect(q.amountCents).toBe(8850);
    expect(q.faceValueCents).toBe(10000);
    expect(q.window?.id).toBe("w1");
  });
  it("no multiplier online or on other days", () => {
    expect(quoteRedemption({ ...base, channel: "web" }, rules(), [wednesday]).amountCents).toBe(4425);
    expect(quoteRedemption({ ...base, at: THU_0000_EDT }, rules(), [wednesday]).amountCents).toBe(4425);
  });
  it("enforces min / step / balance / member", () => {
    expect(quoteRedemption({ ...base, points: 400 }, rules(), []).error).toMatch(/Minimum/);
    expect(quoteRedemption({ ...base, points: 550 }, rules(), []).error).toMatch(/steps of 100/);
    expect(quoteRedemption({ ...base, points: 1100 }, rules(), []).error).toMatch(/Not enough/);
    expect(quoteRedemption({ ...base, points: 50.5 }, rules(), []).ok).toBe(false);
    expect(quoteRedemption({ ...base, isMember: false }, rules(), []).error).toMatch(/members/);
    expect(quoteRedemption({ ...base, isMember: false }, rules({ redeemRequiresMember: false }), []).ok).toBe(true);
    expect(quoteRedemption({ ...base, balance: null, points: 5000 }, rules(), []).ok).toBe(true);
  });
  it("min / step are configurable", () => {
    const r = rules({ minRedeemPoints: 250, redeemStepPoints: 50 });
    expect(quoteRedemption({ ...base, points: 250 }, r, []).ok).toBe(true);
    expect(quoteRedemption({ ...base, points: 275 }, r, []).ok).toBe(false);
  });
});

describe("redeemPointOptions", () => {
  it("lists min..balance in steps", () => {
    expect(redeemPointOptions(820, { minRedeemPoints: 500, redeemStepPoints: 100 })).toEqual([500, 600, 700, 800]);
    expect(redeemPointOptions(499, { minRedeemPoints: 500, redeemStepPoints: 100 })).toEqual([]);
    expect(redeemPointOptions(400, { minRedeemPoints: 250, redeemStepPoints: 100 })).toEqual([300, 400]);
    expect(redeemPointOptions(100000, { minRedeemPoints: 500, redeemStepPoints: 100 }, 5)).toHaveLength(5);
  });
});
