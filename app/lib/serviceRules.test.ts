import { describe, expect, it } from "vitest";

import {
  DEFAULT_ETA_RULES,
  NEXT_STATUSES,
  SERVICE_TYPE_SEED,
  STORE_SEED,
  TICKET_STATUSES,
  computeEta,
  fieldNeeds,
  normalizePhone,
  parseEtaRules,
  validateTicketInput,
} from "./serviceRules";

const rh = STORE_SEED[0];
const base = {
  storeKey: "rh",
  tagNumber: 12,
  customerName: "Test",
  email: "t@example.com",
  phone: null,
  serviceKeys: ["hand_wax"],
  equipment: "ski",
  heightCm: null,
  weightKg: null,
};

describe("fieldNeeds", () => {
  it("wax / rust / base grind need nothing extra", () => {
    const sel = SERVICE_TYPE_SEED.filter((s) => ["hand_wax", "rust_removal", "base_grind"].includes(s.key));
    expect(fieldNeeds(sel, "ski")).toEqual({ edgeAngle: false, bodyMetrics: false, snowboardStance: false });
  });
  it("anything with edge sharpening asks for an optional angle", () => {
    const sel = SERVICE_TYPE_SEED.filter((s) => s.key === "essential_tune");
    expect(fieldNeeds(sel, "ski").edgeAngle).toBe(true);
  });
  it("binding work: ski needs height/weight, snowboard needs stance", () => {
    const sel = SERVICE_TYPE_SEED.filter((s) => s.key === "binding_install");
    expect(fieldNeeds(sel, "ski")).toMatchObject({ bodyMetrics: true, snowboardStance: false });
    expect(fieldNeeds(sel, "snowboard")).toMatchObject({ bodyMetrics: false, snowboardStance: true });
  });
});

describe("validateTicketInput", () => {
  it("accepts the minimal wax ticket", () => {
    expect(validateTicketInput(base, SERVICE_TYPE_SEED, rh)).toEqual([]);
  });
  it("needs email or phone, not both", () => {
    expect(validateTicketInput({ ...base, email: null, phone: null }, SERVICE_TYPE_SEED, rh)).toContain(
      "Email or phone is required so we can tell you when it is ready",
    );
    expect(validateTicketInput({ ...base, email: null, phone: "(647) 555-0100" }, SERVICE_TYPE_SEED, rh)).toEqual([]);
  });
  it("rejects tags outside the store range", () => {
    expect(validateTicketInput({ ...base, tagNumber: 2500 }, SERVICE_TYPE_SEED, rh).join(" ")).toMatch(/does not belong/);
    expect(validateTicketInput({ ...base, tagNumber: null }, SERVICE_TYPE_SEED, rh).join(" ")).toMatch(/Tag number is required/);
  });
  it("rejects services not offered at the store", () => {
    const nmk = STORE_SEED[2];
    const errs = validateTicketInput({ ...base, storeKey: "nmk", tagNumber: 4100, serviceKeys: ["full_tune"] }, SERVICE_TYPE_SEED, nmk);
    expect(errs.join(" ")).toMatch(/not offered/);
  });
  it("ski binding mount needs height and weight, DIN stays optional", () => {
    const errs = validateTicketInput({ ...base, serviceKeys: ["flat_mount"] }, SERVICE_TYPE_SEED, rh);
    expect(errs).toContain("Height (cm) is required for binding work");
    expect(errs).toContain("Weight (kg) is required for binding work");
    expect(validateTicketInput({ ...base, serviceKeys: ["flat_mount"], heightCm: 175, weightKg: 70 }, SERVICE_TYPE_SEED, rh)).toEqual([]);
  });
  it("snowboard binding work needs no body metrics", () => {
    expect(validateTicketInput({ ...base, serviceKeys: ["binding_install"], equipment: "snowboard" }, SERVICE_TYPE_SEED, rh)).toEqual([]);
  });
});

describe("normalizePhone", () => {
  it("adds the North American country code to 10 digits", () => {
    expect(normalizePhone("(647) 555-0100")).toBe("16475550100");
    expect(normalizePhone("+1 647 555 0100")).toBe("16475550100");
  });
});

describe("computeEta", () => {
  const tz = "America/Toronto";
  const morning = new Date("2026-11-03T15:00:00Z"); // Tue 10:00 Toronto
  const late = new Date("2026-11-03T21:30:00Z"); // Tue 16:30 Toronto
  it("front of queue in the morning → today", () => {
    expect(computeEta(0, DEFAULT_ETA_RULES, morning, tz)).toMatchObject({ date: "2026-11-03", daysOut: 0, label: "Today" });
  });
  it("front of queue after the cutoff → tomorrow", () => {
    expect(computeEta(0, DEFAULT_ETA_RULES, late, tz)).toMatchObject({ date: "2026-11-04", daysOut: 1, label: "Tomorrow" });
  });
  it("2–5 ahead → next day; more than 10 → day after", () => {
    expect(computeEta(3, DEFAULT_ETA_RULES, morning, tz).daysOut).toBe(1);
    expect(computeEta(10, DEFAULT_ETA_RULES, morning, tz).daysOut).toBe(1);
    expect(computeEta(11, DEFAULT_ETA_RULES, morning, tz)).toMatchObject({ daysOut: 2, label: "In 2 days" });
    expect(computeEta(40, DEFAULT_ETA_RULES, morning, tz).daysOut).toBe(2);
  });
  it("skips closed weekdays", () => {
    const rules = { ...DEFAULT_ETA_RULES, closedWeekdays: [3] }; // Wednesday closed
    expect(computeEta(3, rules, morning, tz).date).toBe("2026-11-05");
  });
  it("uses the local date even when UTC has rolled over", () => {
    const lateNight = new Date("2026-11-04T03:30:00Z"); // Tue 22:30 Toronto
    expect(computeEta(0, DEFAULT_ETA_RULES, lateNight, tz).date).toBe("2026-11-04");
  });
  it("custom tiers from the dashboard are honoured", () => {
    const rules = parseEtaRules({ tiers: [{ maxAhead: 2, days: 0 }, { maxAhead: null, days: 3 }], sameDayUntilHour: 18 });
    expect(computeEta(2, rules, late, tz).daysOut).toBe(0);
    expect(computeEta(3, rules, late, tz).daysOut).toBe(3);
  });
});

describe("parseEtaRules", () => {
  it("falls back to defaults on garbage", () => {
    expect(parseEtaRules(null)).toEqual(DEFAULT_ETA_RULES);
    expect(parseEtaRules({ tiers: "nope" }).tiers).toEqual(DEFAULT_ETA_RULES.tiers);
  });
  it("drops invalid weekdays", () => {
    expect(parseEtaRules({ closedWeekdays: [0, 7, -1, 6] }).closedWeekdays).toEqual([0, 6]);
  });
});

describe("status machine", () => {
  it("every status has transitions and they all exist", () => {
    for (const s of TICKET_STATUSES) {
      expect(NEXT_STATUSES[s].length).toBeGreaterThan(0);
      for (const n of NEXT_STATUSES[s]) expect(TICKET_STATUSES).toContain(n);
    }
  });
  it("ready can only go to picked up or back to work", () => {
    expect(NEXT_STATUSES.ready).toEqual(["picked_up", "in_progress"]);
  });
});
