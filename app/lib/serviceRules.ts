// 服务工单的纯规则（无 I/O，可单测）：三店默认目录、字段要求、tag 号段校验、预计取板日期。
// 老板 2026-10-30 定：蜡 / 除锈 / 磨底只要联系方式 + tag；含修刃的多一个可选刃角；装固定器要身高体重（DIN 可选）或单板角度；
// 免责不进这张表；预计日期按排队数分档，后台可调，客人看到具体日期并随繁忙度更新。

export type StoreKey = "rh" | "ott" | "nmk";
export const STORE_KEYS: StoreKey[] = ["rh", "ott", "nmk"];

export type ServiceCategory = "wax" | "edge" | "tune" | "base" | "mount" | "boot" | "other";

export type ServiceTypeSeed = {
  key: string;
  name: string;
  category: ServiceCategory;
  durationMin: number;
  priceCents: number | null;
  memberPriceCents: number | null;
  needsEdgeAngle: boolean;
  needsBodyMetrics: boolean;
  stores: StoreKey[];
  sortOrder: number;
};

/** 三店海报（2026-10-30）。工时是起步估计，后台可改。 */
export const SERVICE_TYPE_SEED: ServiceTypeSeed[] = [
  { key: "machine_wax", name: "Machine Hot Wax", category: "wax", durationMin: 15, priceCents: 1500, memberPriceCents: 750, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott"], sortOrder: 10 },
  { key: "hand_wax", name: "Hand Hot Wax", category: "wax", durationMin: 30, priceCents: 3000, memberPriceCents: 1500, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 20 },
  { key: "side_edge", name: "Side Edge Sharpening & Bevel", category: "edge", durationMin: 20, priceCents: 2000, memberPriceCents: 1000, needsEdgeAngle: true, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 30 },
  { key: "essential_tune", name: "Essential Tune (base cleaning + edge sharpening + machine wax)", category: "tune", durationMin: 40, priceCents: 5000, memberPriceCents: 2500, needsEdgeAngle: true, needsBodyMetrics: false, stores: ["rh", "ott"], sortOrder: 40 },
  { key: "performance_tune", name: "Performance Tune (base cleaning + edge sharpening + hand wax)", category: "tune", durationMin: 50, priceCents: 6000, memberPriceCents: 3000, needsEdgeAngle: true, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 50 },
  { key: "full_tune", name: "Full Tune (base cleaning + base grind + edge sharpening + hand wax)", category: "tune", durationMin: 60, priceCents: 8000, memberPriceCents: 4000, needsEdgeAngle: true, needsBodyMetrics: false, stores: ["rh"], sortOrder: 60 },
  { key: "base_grind", name: "Base Grind", category: "base", durationMin: 20, priceCents: 2000, memberPriceCents: 1000, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh"], sortOrder: 70 },
  { key: "full_edge_tune", name: "Full Edge Tune", category: "edge", durationMin: 30, priceCents: 3000, memberPriceCents: 1500, needsEdgeAngle: true, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 80 },
  { key: "rust_removal", name: "Edge Rust Removal & Deburring", category: "edge", durationMin: 15, priceCents: 500, memberPriceCents: null, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 90 },
  { key: "base_repair", name: "Base Repair", category: "base", durationMin: 30, priceCents: 2000, memberPriceCents: null, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott"], sortOrder: 100 },
  { key: "base_cleaning", name: "Base Cleaning", category: "base", durationMin: 15, priceCents: 2000, memberPriceCents: 1000, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 110 },
  { key: "binding_install", name: "Binding Installation & Adjustment", category: "mount", durationMin: 30, priceCents: 3000, memberPriceCents: 1500, needsEdgeAngle: false, needsBodyMetrics: true, stores: ["rh", "ott", "nmk"], sortOrder: 120 },
  { key: "flat_mount", name: "Flat Ski Binding Mount", category: "mount", durationMin: 45, priceCents: 8000, memberPriceCents: 4000, needsEdgeAngle: false, needsBodyMetrics: true, stores: ["rh", "ott", "nmk"], sortOrder: 130 },
  { key: "boot_molding", name: "Boot Shell / Liner Heat Molding", category: "boot", durationMin: 30, priceCents: 2000, memberPriceCents: 1000, needsEdgeAngle: false, needsBodyMetrics: false, stores: ["rh", "ott", "nmk"], sortOrder: 140 },
];

export type StoreSeed = {
  key: StoreKey;
  name: string;
  shopifyLocationId: string;
  tagMin: number;
  tagMax: number;
  sortOrder: number;
};

export const STORE_SEED: StoreSeed[] = [
  { key: "rh", name: "Richmond Hill", shopifyLocationId: "gid://shopify/Location/74898440447", tagMin: 1, tagMax: 2000, sortOrder: 1 },
  { key: "ott", name: "Ottawa", shopifyLocationId: "gid://shopify/Location/89611927807", tagMin: 2001, tagMax: 4000, sortOrder: 2 },
  { key: "nmk", name: "Newmarket", shopifyLocationId: "gid://shopify/Location/79309832447", tagMin: 4001, tagMax: 5000, sortOrder: 3 },
];

// ── 字段要求 ─────────────────────────────────────────────────────────────────

export type FieldNeeds = { edgeAngle: boolean; bodyMetrics: boolean; snowboardStance: boolean };

/** 选中的服务 × 器材 → 表单要出现哪些可选 / 必填字段。 */
export function fieldNeeds(
  selected: Array<Pick<ServiceTypeSeed, "needsEdgeAngle" | "needsBodyMetrics">>,
  equipment: string | null | undefined,
): FieldNeeds {
  const mount = selected.some((s) => s.needsBodyMetrics);
  return {
    edgeAngle: selected.some((s) => s.needsEdgeAngle),
    bodyMetrics: mount && equipment !== "snowboard", // 双板装固定器：身高体重必填，DIN 可选
    snowboardStance: mount && equipment === "snowboard", // 单板：角度 / 站距可选
  };
}

export type TicketInput = {
  storeKey: string;
  tagNumber: number | null;
  customerName: string;
  email: string | null;
  phone: string | null;
  serviceKeys: string[];
  equipment: string | null;
  heightCm: number | null;
  weightKg: number | null;
};

/** 表单校验（服务端、客户端共用）。返回英文错误（客人看）。 */
export function validateTicketInput(
  input: TicketInput,
  catalog: ServiceTypeSeed[],
  store: { key: string; tagMin: number; tagMax: number } | null,
): string[] {
  const errors: string[] = [];
  if (!store) errors.push("Unknown store");
  if (!input.customerName.trim()) errors.push("Name is required");
  const email = (input.email ?? "").trim();
  const phone = (input.phone ?? "").trim();
  if (!email && !phone) errors.push("Email or phone is required so we can tell you when it is ready");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email looks wrong");
  if (phone && normalizePhone(phone).length < 10) errors.push("Phone looks wrong");
  if (input.tagNumber === null || !Number.isInteger(input.tagNumber)) errors.push("Tag number is required (it is printed on the tag staff gave you)");
  else if (store && (input.tagNumber < store.tagMin || input.tagNumber > store.tagMax))
    errors.push(`Tag number ${input.tagNumber} does not belong to this store (expected ${store.tagMin}-${store.tagMax})`);
  if (!input.serviceKeys.length) errors.push("Pick at least one service");
  const selected = catalog.filter((c) => input.serviceKeys.includes(c.key));
  if (selected.length !== input.serviceKeys.length) errors.push("One of the services is not offered at this store");
  if (store) {
    const notHere = selected.filter((s) => !s.stores.includes(store.key as StoreKey));
    if (notHere.length) errors.push(`${notHere.map((s) => s.name).join(", ")} is not offered at this store`);
  }
  const needs = fieldNeeds(selected, input.equipment);
  if (needs.bodyMetrics) {
    if (!input.heightCm || input.heightCm < 80 || input.heightCm > 230) errors.push("Height (cm) is required for binding work");
    if (!input.weightKg || input.weightKg < 15 || input.weightKg > 200) errors.push("Weight (kg) is required for binding work");
  }
  return errors;
}

export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  // 北美：10 位补 1
  return digits.length === 10 ? `1${digits}` : digits;
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const v = (e ?? "").trim().toLowerCase();
  return v || null;
}

// ── 预计取板日期 ────────────────────────────────────────────────────────────

export type EtaTier = { maxAhead: number | null; days: number }; // maxAhead = null → 兜底
export type EtaRules = {
  tiers: EtaTier[];
  sameDayUntilHour: number; // 过了这个点"当天"算第二天
  closedWeekdays: number[]; // 0 = 周日
};

/** 老板 10/30：前面没排队 → 当天；2–5 单 → 当天或第二天；超过 10 单 → 隔一天。中间档按第二天。 */
export const DEFAULT_ETA_RULES: EtaRules = {
  tiers: [
    { maxAhead: 1, days: 0 },
    { maxAhead: 5, days: 1 },
    { maxAhead: 10, days: 1 },
    { maxAhead: null, days: 2 },
  ],
  sameDayUntilHour: 15,
  closedWeekdays: [],
};

export function parseEtaRules(raw: unknown): EtaRules {
  if (!raw || typeof raw !== "object") return DEFAULT_ETA_RULES;
  const r = raw as Partial<EtaRules>;
  const tiers = Array.isArray(r.tiers)
    ? r.tiers
        .filter((t) => t && typeof t === "object" && Number.isFinite(Number((t as EtaTier).days)))
        .map((t) => ({ maxAhead: (t as EtaTier).maxAhead === null ? null : Number((t as EtaTier).maxAhead), days: Number((t as EtaTier).days) }))
    : [];
  return {
    tiers: tiers.length ? tiers : DEFAULT_ETA_RULES.tiers,
    sameDayUntilHour: Number.isFinite(Number(r.sameDayUntilHour)) ? Number(r.sameDayUntilHour) : DEFAULT_ETA_RULES.sameDayUntilHour,
    closedWeekdays: Array.isArray(r.closedWeekdays) ? r.closedWeekdays.map(Number).filter((d) => d >= 0 && d <= 6) : [],
  };
}

/** 当地日期的 Y-M-D / 小时 / 星期 */
export function localParts(at: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hour: Number(parts.hour) % 24, weekday };
}

export type EtaResult = { date: string; daysOut: number; ahead: number; tierDays: number; label: string };

/**
 * ahead = 同店排在前面的未完成工单数；返回当地日期 YYYY-MM-DD。
 * 规则：按 tiers 取 days；days=0 且已过 sameDayUntilHour → 1；落在休息日顺延。
 */
export function computeEta(ahead: number, rules: EtaRules, now: Date, timezone: string): EtaResult {
  const tier = rules.tiers.find((t) => t.maxAhead === null || ahead <= t.maxAhead) ?? rules.tiers[rules.tiers.length - 1];
  let days = Math.max(0, Math.floor(tier.days));
  const local = localParts(now, timezone);
  if (days === 0 && local.hour >= rules.sameDayUntilHour) days = 1;
  // 用当地日期算，不受 UTC 换日影响
  const base = new Date(Date.UTC(local.y, local.m - 1, local.d));
  let out = new Date(base.getTime() + days * 86400000);
  for (let guard = 0; guard < 14 && rules.closedWeekdays.includes(out.getUTCDay()); guard++) out = new Date(out.getTime() + 86400000);
  const date = out.toISOString().slice(0, 10);
  const daysOut = Math.round((out.getTime() - base.getTime()) / 86400000);
  const label = daysOut === 0 ? "Today" : daysOut === 1 ? "Tomorrow" : `In ${daysOut} days`;
  return { date, daysOut, ahead, tierDays: tier.days, label };
}

// ── 状态机 ───────────────────────────────────────────────────────────────────

export type TicketStatus = "received" | "in_progress" | "ready" | "picked_up" | "cancelled" | "on_hold";
export const TICKET_STATUSES: TicketStatus[] = ["received", "in_progress", "ready", "picked_up", "cancelled", "on_hold"];
export const OPEN_STATUSES: TicketStatus[] = ["received", "in_progress", "on_hold"];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  received: "Not started",
  in_progress: "In progress",
  on_hold: "On hold",
  ready: "Ready for pickup",
  picked_up: "Picked up",
  cancelled: "Cancelled",
};

/** 允许的流转（店员按钮只给这些） */
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  received: ["in_progress", "ready", "on_hold", "cancelled"],
  in_progress: ["ready", "on_hold", "cancelled", "received"],
  on_hold: ["in_progress", "received", "cancelled"],
  ready: ["picked_up", "in_progress"],
  picked_up: ["ready"],
  cancelled: ["received"],
};

export function isOpenStatus(s: string): boolean {
  return (OPEN_STATUSES as string[]).includes(s);
}

/** 挂牌号在"未取走"的工单里不能重复：ready 也算占着（板子还在店里）。 */
export const TAG_HOLDING_STATUSES: TicketStatus[] = ["received", "in_progress", "on_hold", "ready"];
