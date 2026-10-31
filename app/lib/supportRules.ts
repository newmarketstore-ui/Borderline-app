// AI 客服：纯函数（无 IO），给接口层和单测共用。
// 老板 2026-10-31 定：只用 Sonnet；英 + 法；转人工进后台 dashboard，店员邮件 / 短信回复。

export type SupportLocale = "en" | "fr";
export type ConversationStatus = "open" | "handoff" | "answered" | "closed";
export const CONVERSATION_STATUSES: ConversationStatus[] = ["open", "handoff", "answered", "closed"];

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: "Open",
  handoff: "Needs staff reply",
  answered: "Replied",
  closed: "Closed",
};

/** 页面语言 → 回答语言。只认 en / fr，其他一律英文。 */
export function normalizeLocale(raw: string | null | undefined): SupportLocale {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "fr" || v.startsWith("fr-") ? "fr" : "en";
}

/** Sonnet 5.5 价格（美元 / 百万 token）→ 微美元 / token。缓存读 0.2、缓存写 2.5。 */
export const PRICE_MICROS = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } as const;

export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** 一次 API 调用的花费（微美元，整数）。 */
export function costMicros(u: UsageLike): number {
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  return Math.round(u.input_tokens * PRICE_MICROS.input + u.output_tokens * PRICE_MICROS.output + cr * PRICE_MICROS.cacheRead + cw * PRICE_MICROS.cacheWrite);
}

export function microsToCents(m: number): number {
  return Math.round(m / 10_000);
}

/** 多伦多日期键（预算按天）。 */
export function dayKey(d: Date, tz = "America/Toronto"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type RateDecision = { ok: true } | { ok: false; reason: "visitor" | "ip" | "turns" | "budget" | "disabled" };

export function rateDecision(p: {
  enabled: boolean;
  visitorLastHour: number;
  ipLastHour: number;
  turnsInConversation: number;
  spentTodayCents: number;
  limits: { perVisitorHourly: number; perIpHourly: number; maxTurns: number; dailyBudgetCents: number };
}): RateDecision {
  if (!p.enabled) return { ok: false, reason: "disabled" };
  if (p.spentTodayCents >= p.limits.dailyBudgetCents) return { ok: false, reason: "budget" };
  if (p.turnsInConversation >= p.limits.maxTurns) return { ok: false, reason: "turns" };
  if (p.visitorLastHour >= p.limits.perVisitorHourly) return { ok: false, reason: "visitor" };
  if (p.ipLastHour >= p.limits.perIpHourly) return { ok: false, reason: "ip" };
  return { ok: true };
}

/** 用户消息清洗：去首尾空白、压掉控制字符、限长。 */
export const MAX_USER_CHARS = 2000;
export function cleanUserText(raw: unknown): string {
  return String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, MAX_USER_CHARS);
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

/** 北美手机 → E.164；不像电话就返回 null。 */
export function normalizePhone(v: string | null | undefined): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15 && String(v).trim().startsWith("+")) return `+${digits}`;
  return null;
}

/** 订单号校验：#1234 / 1234 → "#1234"。 */
export function normalizeOrderName(v: string | null | undefined): string | null {
  const m = String(v ?? "").trim().match(/^#?\s*(\d{3,7})$/);
  return m ? `#${m[1]}` : null;
}

/** 访客 id 只接受我们前端生成的格式（防止把别人的会话 id 猜出来）。 */
export function isVisitorId(v: unknown): v is string {
  return typeof v === "string" && /^v_[A-Za-z0-9_-]{16,64}$/.test(v);
}

export const UI_TEXT: Record<SupportLocale, Record<string, string>> = {
  en: {
    offline: "Our assistant is taking a break. Leave your question and a way to reach you — a staff member will reply by email.",
    rate_visitor: "You've sent a lot of messages in a short time. Please wait a few minutes, or leave your question for our staff below.",
    rate_turns: "This conversation is getting long. Leave your question below and a staff member will take it from here.",
    handoff_ask_contact: "Leave your email (or phone) and a staff member will get back to you.",
    handoff_done: "Thanks — your question is with our team. We reply by email during store hours.",
    error: "Sorry, something went wrong on our side. Please try again, or leave your question for our staff below.",
  },
  fr: {
    offline: "Notre assistant fait une pause. Laissez votre question et un moyen de vous joindre — un membre de l’équipe vous répondra par courriel.",
    rate_visitor: "Vous avez envoyé beaucoup de messages en peu de temps. Patientez quelques minutes ou laissez votre question à notre équipe ci-dessous.",
    rate_turns: "Cette conversation devient longue. Laissez votre question ci-dessous et un membre de l’équipe prendra le relais.",
    handoff_ask_contact: "Laissez votre courriel (ou téléphone) et un membre de l’équipe vous répondra.",
    handoff_done: "Merci — votre question est transmise à notre équipe. Nous répondons par courriel pendant les heures d’ouverture.",
    error: "Désolé, une erreur s’est produite de notre côté. Réessayez ou laissez votre question à notre équipe ci-dessous.",
  },
};

/** 店员回复可以走哪些渠道（短信要 Klaviyo 开通 SMS 后才真发）。 */
export function replyChannels(c: { email?: string | null; phone?: string | null }, smsEnabled: boolean): Array<"email" | "sms"> {
  const out: Array<"email" | "sms"> = [];
  if (c.email) out.push("email");
  if (c.phone && smsEnabled) out.push("sms");
  return out;
}
