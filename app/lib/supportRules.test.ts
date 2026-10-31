import { describe, expect, it } from "vitest";

import { knowledgeBasePrompt, turnContextText } from "./supportPrompt";
import { cleanUserText, costMicros, dayKey, isVisitorId, microsToCents, normalizeLocale, normalizeOrderName, normalizePhone, rateDecision, replyChannels } from "./supportRules";

describe("support rules", () => {
  it("normalizes locale to en/fr only", () => {
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("fr-CA")).toBe("fr");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("zh-CN")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
  });

  it("prices a Sonnet call in micro-dollars", () => {
    // 1000 in + 200 out + 8000 cache read + 0 cache write = 2000 + 2000 + 1600 = 5600 µ$ = 0.56 ¢
    const m = costMicros({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 });
    expect(m).toBe(5600);
    expect(microsToCents(m)).toBe(1);
    expect(microsToCents(1_000_000)).toBe(100);
  });

  it("uses Toronto day keys", () => {
    expect(dayKey(new Date("2026-11-01T03:30:00Z"))).toBe("2026-10-31"); // 23:30 Toronto
    expect(dayKey(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
  });

  it("gates by budget, turns, visitor and ip in that order", () => {
    const limits = { perVisitorHourly: 30, perIpHourly: 80, maxTurns: 40, dailyBudgetCents: 1500 };
    const base = { enabled: true, visitorLastHour: 0, ipLastHour: 0, turnsInConversation: 0, spentTodayCents: 0, limits };
    expect(rateDecision(base)).toEqual({ ok: true });
    expect(rateDecision({ ...base, enabled: false })).toEqual({ ok: false, reason: "disabled" });
    expect(rateDecision({ ...base, spentTodayCents: 1500 })).toEqual({ ok: false, reason: "budget" });
    expect(rateDecision({ ...base, turnsInConversation: 40 })).toEqual({ ok: false, reason: "turns" });
    expect(rateDecision({ ...base, visitorLastHour: 30 })).toEqual({ ok: false, reason: "visitor" });
    expect(rateDecision({ ...base, ipLastHour: 80 })).toEqual({ ok: false, reason: "ip" });
  });

  it("cleans and caps user text", () => {
    expect(cleanUserText("  hi\u0000 there \n")).toBe("hi there");
    expect(cleanUserText("x".repeat(3000)).length).toBe(2000);
    expect(cleanUserText(null)).toBe("");
  });

  it("normalizes phones and order names", () => {
    expect(normalizePhone("(905) 555-1234")).toBe("+19055551234");
    expect(normalizePhone("1 905 555 1234")).toBe("+19055551234");
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizeOrderName("#23157")).toBe("#23157");
    expect(normalizeOrderName(" 23157 ")).toBe("#23157");
    expect(normalizeOrderName("order 23157")).toBeNull();
  });

  it("accepts only our visitor id format", () => {
    expect(isVisitorId("v_" + "a".repeat(36))).toBe(true);
    expect(isVisitorId("v_short")).toBe(false);
    expect(isVisitorId("clxyz123")).toBe(false);
    expect(isVisitorId(42)).toBe(false);
  });

  it("offers reply channels by contact and SMS switch", () => {
    expect(replyChannels({ email: "a@b.ca", phone: "+1905" }, false)).toEqual(["email"]);
    expect(replyChannels({ email: "a@b.ca", phone: "+1905" }, true)).toEqual(["email", "sms"]);
    expect(replyChannels({ email: null, phone: null }, true)).toEqual([]);
  });
});

describe("support prompt", () => {
  it("renders the knowledge base with keys and stays stable for caching", () => {
    const docs = [
      { key: "shipping", title: "Shipping", category: "policy", body: "Free over $149.\n" },
      { key: "returns", title: "Returns", category: "policy", body: "14 days." },
    ];
    const a = knowledgeBasePrompt(docs);
    expect(a).toContain("### Shipping [shipping]");
    expect(a).toContain("### Returns [returns]");
    expect(knowledgeBasePrompt(docs)).toBe(a);
    expect(knowledgeBasePrompt([])).toMatch(/empty/);
  });

  it("puts the product on the page and login state into the turn context", () => {
    const t = turnContextText({
      locale: "fr",
      today: "Saturday 2026-10-31",
      pageUrl: "https://borderlinestore.ca/products/x",
      productHandle: "elan-wingman-86",
      customer: { loggedIn: true, name: "Test", email: "t@x.ca", isPaidMember: true },
      conversationStatus: "open",
      contactKnown: true,
    });
    expect(t).toContain("page_language: fr");
    expect(t).toContain("product_on_page: elan-wingman-86");
    expect(t).toContain("logged in as Test <t@x.ca>, paid member");
    expect(t).toContain("contact_known: yes");
    const g = turnContextText({ locale: "en", today: "x", customer: null, conversationStatus: "open", contactKnown: false });
    expect(g).toContain("not logged in");
    expect(g).not.toContain("product_on_page");
  });
});
