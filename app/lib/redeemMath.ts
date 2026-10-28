// 兑分报价纯函数（服务端发码和店员页面实时预览共用，所以不能 import 任何 .server 模块）。
// 口径（Appstle 现行，reports/积分迁移_Appstle导出_2026-10-28.md §七）：
//   10 分 = $1，且这 $1 是「含税」价值；加拿大税在折扣之后算，所以税前折扣 = 分 / 10 / (1 + 13%)。
//   500 分 → $44.25（四舍五入到分；Appstle 后台手填的是 $44.30，相当于 up_10_cents）。
//   周三 ×2（只限 POS、只限会员）：500 分 → $88.50。
// 金额全程用 BigInt 有理数算，最后一步才取整，避免先乘倍数再除税率的两次取整。

export type RedeemChannel = "pos" | "web";
export const REDEEM_CHANNELS: RedeemChannel[] = ["pos", "web"];

export type RedeemRounding = "nearest_cent" | "floor_cent" | "up_10_cents";
export const REDEEM_ROUNDINGS: RedeemRounding[] = ["nearest_cent", "floor_cent", "up_10_cents"];

export type RedeemWindowRule = {
  id?: string;
  label?: string | null;
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday（当地时间）
  startHour: number | null; // 含
  endHour: number | null; // 不含；都为 null = 全天
  timezone: string;
  multiplier: number;
  channels: string[]; // 空 = 所有渠道
  memberOnly: boolean;
  active: boolean;
  minSpendEqualsDiscount?: boolean; // 命中时折扣码要求订单小计 ≥ 折扣额（Appstle 周三规则）
};

export type RedeemQuoteRules = {
  redeemPointsPerDollar: number;
  minRedeemPoints: number;
  redeemStepPoints: number;
  redeemAmountIsTaxInclusive: boolean;
  assumedTaxRate: number; // 0.13
  redeemRounding: RedeemRounding;
  redeemRequiresMember: boolean;
};

export type QuoteInput = {
  points: number;
  channel: RedeemChannel;
  at: Date;
  isMember: boolean;
  balance: number | null; // null = 不查余额（只算价）
};

export type RedemptionQuote = {
  ok: boolean;
  error: string | null;
  points: number;
  channel: RedeemChannel;
  multiplier: number;
  window: { id: string | null; label: string | null; minSpendEqualsDiscount: boolean } | null;
  minSubtotalCents: number | null; // 折扣码的最低订单小计（命中 minSpendEqualsDiscount 窗口时 = amountCents）
  faceValueCents: number; // 顾客感知价值（含税口径），= 分 × 倍数 / 每 $1 分数
  amountCents: number; // 实际发出的固定金额折扣（税前）
  taxRate: number;
  rounding: RedeemRounding;
};

const SCALE = 10_000n;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const scaled = (n: number) => BigInt(Math.round((Number.isFinite(n) && n > 0 ? n : 0) * Number(SCALE)));

/** 某时刻在某时区的星期几（0 = 周日）和小时（0–23）。 */
export function localDayHour(at: Date, timezone: string): { dayOfWeek: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return { dayOfWeek: Math.max(0, WEEKDAYS.indexOf(wd)), hour };
}

export function windowMatches(
  w: RedeemWindowRule,
  ctx: { at: Date; channel: RedeemChannel; isMember: boolean },
): boolean {
  if (!w.active || !(w.multiplier > 0)) return false;
  if (w.memberOnly && !ctx.isMember) return false;
  if (w.channels.length > 0 && !w.channels.includes(ctx.channel)) return false;
  const { dayOfWeek, hour } = localDayHour(ctx.at, w.timezone || "America/Toronto");
  if (dayOfWeek !== w.dayOfWeek) return false;
  if (w.startHour !== null && hour < w.startHour) return false;
  if (w.endHour !== null && hour >= w.endHour) return false;
  return true;
}

/** 多个窗口同时命中时取倍数最大的那个。 */
export function activeWindow(
  windows: RedeemWindowRule[],
  ctx: { at: Date; channel: RedeemChannel; isMember: boolean },
): RedeemWindowRule | null {
  let best: RedeemWindowRule | null = null;
  for (const w of windows) if (windowMatches(w, ctx) && (!best || w.multiplier > best.multiplier)) best = w;
  return best;
}

/** 分 × 倍数 → 税前折扣金额（分），按 rounding 取整。 */
export function redeemAmountCents(
  points: number,
  multiplier: number,
  rules: Pick<RedeemQuoteRules, "redeemPointsPerDollar" | "redeemAmountIsTaxInclusive" | "assumedTaxRate" | "redeemRounding">,
): { faceValueCents: number; amountCents: number } {
  if (!(points > 0) || !(rules.redeemPointsPerDollar > 0)) return { faceValueCents: 0, amountCents: 0 };
  // 含税价值（分）= points × mult × 100 / ppd
  const faceNum = BigInt(Math.trunc(points)) * scaled(multiplier) * 100n;
  const faceDen = BigInt(Math.trunc(rules.redeemPointsPerDollar)) * SCALE;
  const faceValueCents = Number((faceNum * 2n + faceDen) / (faceDen * 2n));
  const taxS = rules.redeemAmountIsTaxInclusive ? scaled(rules.assumedTaxRate) : 0n;
  const num = faceNum * SCALE;
  const den = faceDen * (SCALE + taxS);
  let amount: bigint;
  switch (rules.redeemRounding) {
    case "floor_cent":
      amount = num / den;
      break;
    case "up_10_cents":
      amount = ((num + den * 10n - 1n) / (den * 10n)) * 10n;
      break;
    default:
      amount = (num * 2n + den) / (den * 2n); // 四舍五入（.5 进位）
  }
  return { faceValueCents, amountCents: Number(amount) };
}

export function quoteRedemption(input: QuoteInput, rules: RedeemQuoteRules, windows: RedeemWindowRule[]): RedemptionQuote {
  const win = activeWindow(windows, input);
  const multiplier = win ? win.multiplier : 1;
  const { faceValueCents, amountCents } = redeemAmountCents(input.points, multiplier, rules);
  const base = {
    points: input.points,
    channel: input.channel,
    multiplier,
    window: win
      ? { id: win.id ?? null, label: win.label ?? null, minSpendEqualsDiscount: Boolean(win.minSpendEqualsDiscount) }
      : null,
    faceValueCents,
    amountCents,
    minSubtotalCents: win?.minSpendEqualsDiscount && amountCents > 0 ? amountCents : null,
    taxRate: rules.redeemAmountIsTaxInclusive ? rules.assumedTaxRate : 0,
    rounding: rules.redeemRounding,
  };
  const fail = (error: string): RedemptionQuote => ({ ...base, ok: false, error });
  if (!Number.isInteger(input.points) || input.points <= 0) return fail("Points must be a positive whole number");
  if (rules.redeemRequiresMember && !input.isMember) return fail("Only paying members can redeem points");
  if (input.points < rules.minRedeemPoints) return fail(`Minimum redemption is ${rules.minRedeemPoints} points`);
  if (rules.redeemStepPoints > 0 && input.points % rules.redeemStepPoints !== 0)
    return fail(`Redeem in steps of ${rules.redeemStepPoints} points`);
  if (input.balance !== null && input.points > input.balance) return fail("Not enough points");
  if (amountCents <= 0) return fail("Redemption value rounds to $0");
  return { ...base, ok: true, error: null };
}

/** 店员下拉框选项：从最低起按步长到余额（最多 maxOptions 个）。 */
export function redeemPointOptions(
  balance: number,
  rules: Pick<RedeemQuoteRules, "minRedeemPoints" | "redeemStepPoints">,
  maxOptions = 60,
): number[] {
  const step = Math.max(1, rules.redeemStepPoints);
  let start = Math.max(rules.minRedeemPoints, step);
  if (start % step !== 0) start = Math.ceil(start / step) * step;
  const out: number[] = [];
  for (let p = start; p <= balance && out.length < maxOptions; p += step) out.push(p);
  return out;
}

/**
 * 兑换码的 discountCodeBasicCreate 输入。customerSelection 已废弃，用 context.customers。
 * minSubtotalCents 非空 → minimumRequirement.subtotal（订单小计 ≥ 该金额才能用；POS 同样校验）。
 */
export function redemptionDiscountInput(
  r: { code: string; amountCents: number; expiresAt: Date; minSubtotalCents?: number | null },
  customerGid: string,
  now: Date,
) {
  const dollars = (cents: number) => (cents / 100).toFixed(2);
  return {
    title: r.code,
    code: r.code,
    startsAt: now.toISOString(),
    endsAt: r.expiresAt.toISOString(),
    context: { customers: { add: [customerGid] } },
    customerGets: {
      value: { discountAmount: { amount: dollars(r.amountCents), appliesOnEachItem: false } },
      items: { all: true },
    },
    ...(r.minSubtotalCents && r.minSubtotalCents > 0
      ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: dollars(r.minSubtotalCents) } } }
      : {}),
    appliesOncePerCustomer: true,
    usageLimit: 1,
  };
}

export const formatCents = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
