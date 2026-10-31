// AI 客服：设置 / 知识库 / 会话 / 用量 / 转人工与店员回复通知。模型调用在 supportChat.server.ts。
import { randomBytes } from "node:crypto";

import type { Prisma, SupportConfig, SupportConversation, SupportKbDoc, SupportMessage } from "@prisma/client";

import prisma from "../db.server";
import { sendKlaviyoEvent } from "../lib/klaviyo.server";
import { costMicros, dayKey, microsToCents, normalizePhone, type ConversationStatus, type UsageLike } from "../lib/supportRules";
import { gql, type AdminGraphql } from "./loyalty.server";
import { KB_SEED } from "./supportKbSeed";

export type { SupportConfig, SupportConversation, SupportKbDoc, SupportMessage };

// ───────────────────────────── 设置 ─────────────────────────────

export async function getSupportConfig(shop: string): Promise<SupportConfig> {
  const row = await prisma.supportConfig.findUnique({ where: { shopDomain: shop } });
  if (row) return row;
  return prisma.supportConfig.create({ data: { shopDomain: shop } });
}

export type SupportConfigInput = Partial<Pick<SupportConfig, "enabled" | "model" | "dailyBudgetCents" | "perVisitorHourly" | "perIpHourly" | "maxTurns" | "staffEmails" | "greetingEn" | "greetingFr" | "extraPrompt">>;

export async function saveSupportConfig(shop: string, data: SupportConfigInput, by: string): Promise<SupportConfig> {
  await getSupportConfig(shop);
  return prisma.supportConfig.update({ where: { shopDomain: shop }, data: { ...data, updatedBy: by } });
}

// ───────────────────────────── 知识库 ─────────────────────────────

export async function listKb(shop: string, opts: { enabledOnly?: boolean } = {}): Promise<SupportKbDoc[]> {
  return prisma.supportKbDoc.findMany({
    where: { shopDomain: shop, ...(opts.enabledOnly ? { enabled: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
}

export async function upsertKb(shop: string, key: string, data: Partial<Pick<SupportKbDoc, "title" | "category" | "body" | "sourceUrl" | "enabled" | "sortOrder">>, by: string) {
  const k = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 60);
  if (!k) throw new Error("Key is required");
  return prisma.supportKbDoc.upsert({
    where: { shopDomain_key: { shopDomain: shop, key: k } },
    create: { shopDomain: shop, key: k, title: data.title ?? k, category: data.category ?? "other", body: data.body ?? "", sourceUrl: data.sourceUrl ?? null, enabled: data.enabled ?? true, sortOrder: data.sortOrder ?? 500, updatedBy: by },
    update: { ...data, updatedBy: by },
  });
}

export async function deleteKb(shop: string, key: string) {
  await prisma.supportKbDoc.deleteMany({ where: { shopDomain: shop, key } });
}

const LOCATIONS_QUERY = `#graphql
  query SupportLocations {
    locations(first: 10, query: "active:true") {
      nodes { id name address { address1 address2 city provinceCode zip phone } }
    }
    shop { shippingPolicy { body } refundPolicy { body } }
  }`;

function stripHtml(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d|tr|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 写默认知识库。overwrite=false 时只补缺的 key（不动老板改过的）。
 * 另外从 Shopify 读门店地址 / 电话 + 官方 shipping / refund 政策原文各成一篇（key: stores / policy_shipping_official / policy_refund_official）。
 */
export async function seedKb(shop: string, admin: AdminGraphql | null, by: string, overwrite = false): Promise<{ written: string[]; skipped: string[] }> {
  const existing = new Set((await listKb(shop)).map((d) => d.key));
  const written: string[] = [];
  const skipped: string[] = [];
  const put = async (key: string, title: string, category: string, sortOrder: number, body: string, sourceUrl?: string) => {
    if (existing.has(key) && !overwrite) {
      skipped.push(key);
      return;
    }
    await upsertKb(shop, key, { title, category, body, sortOrder, sourceUrl: sourceUrl ?? null, enabled: true }, by);
    written.push(key);
  };
  for (const d of KB_SEED) await put(d.key, d.title, d.category, d.sortOrder, d.body);

  if (admin) {
    try {
      const data = await gql<{
        locations: { nodes: Array<{ id: string; name: string; address: { address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; phone: string | null } }> };
        shop: { shippingPolicy: { body: string } | null; refundPolicy: { body: string } | null };
      }>(admin, LOCATIONS_QUERY);
      const stores = await prisma.serviceStore.findMany({ where: { shopDomain: shop } });
      const lines = data.locations.nodes
        .filter((l) => !/warehouse|online|hq/i.test(l.name))
        .map((l) => {
          const s = stores.find((x) => x.shopifyLocationId === l.id);
          const addr = [l.address.address1, l.address.address2, l.address.city, l.address.provinceCode, l.address.zip].filter(Boolean).join(", ");
          const hours = s?.hoursText ? ` Hours: ${s.hoursText}.` : "";
          const phone = s?.phone ?? l.address.phone;
          return `- ${l.name}: ${addr}.${phone ? ` Phone ${phone}.` : ""}${hours}`;
        });
      await put(
        "stores",
        "Our stores",
        "store",
        5,
        `${lines.join("\n")}\n- Opening hours can change on holidays; if hours are not listed above, tell the customer to check the store page on the website or call.\n- Newmarket is the clearance / outlet store with shorter hours; Richmond Hill and Ottawa carry the full winter range and do tuning on site.`,
      );
      if (data.shop.shippingPolicy?.body) await put("policy_shipping_official", "Official shipping policy (website text)", "policy", 11, stripHtml(data.shop.shippingPolicy.body).slice(0, 6000), "https://borderlinestore.ca/policies/shipping-policy");
      if (data.shop.refundPolicy?.body) await put("policy_refund_official", "Official refund policy (website text)", "policy", 31, stripHtml(data.shop.refundPolicy.body).slice(0, 6000), "https://borderlinestore.ca/policies/refund-policy");
    } catch (e) {
      console.warn("[support] seed from Shopify failed:", (e as Error).message);
    }
  }
  return { written, skipped };
}

// ───────────────────────────── 会话 ─────────────────────────────

const token = () => randomBytes(18).toString("base64url");

export type EnsureConversationParams = {
  shop: string;
  visitorId: string;
  conversationId?: string | null;
  customerGid?: string | null;
  locale: string;
  pageUrl?: string | null;
  productHandle?: string | null;
  ipHash?: string | null;
};

/** 找访客当前会话（必须是他自己的），否则新建。登录顾客顺便把名字邮箱带上。 */
export async function ensureConversation(p: EnsureConversationParams): Promise<SupportConversation> {
  let c: SupportConversation | null = null;
  if (p.conversationId) {
    c = await prisma.supportConversation.findFirst({ where: { id: p.conversationId, shopDomain: p.shop, visitorId: p.visitorId } });
    if (c && c.status === "closed") c = null;
  }
  const member = p.customerGid ? await prisma.member.findUnique({ where: { shopifyCustomerId: p.customerGid } }) : null;
  const identity = member
    ? { memberId: member.id, name: [member.firstName, member.lastName].filter(Boolean).join(" ") || null, email: member.email, phone: member.phone }
    : {};
  if (c) {
    const patch: Prisma.SupportConversationUpdateInput = {};
    if (p.customerGid && !c.customerGid) Object.assign(patch, { customerGid: p.customerGid, ...identity });
    if (p.pageUrl && p.pageUrl !== c.pageUrl) patch.pageUrl = p.pageUrl;
    if (p.productHandle !== undefined && p.productHandle !== c.productHandle) patch.productHandle = p.productHandle;
    return Object.keys(patch).length ? prisma.supportConversation.update({ where: { id: c.id }, data: patch }) : c;
  }
  return prisma.supportConversation.create({
    data: {
      shopDomain: p.shop,
      visitorId: p.visitorId,
      token: token(),
      customerGid: p.customerGid ?? null,
      locale: p.locale,
      pageUrl: p.pageUrl ?? null,
      productHandle: p.productHandle ?? null,
      ipHash: p.ipHash ?? null,
      ...identity,
    },
  });
}

export async function getConversationForVisitor(shop: string, visitorId: string, id: string) {
  return prisma.supportConversation.findFirst({ where: { id, shopDomain: shop, visitorId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
}

export async function getConversationByToken(shop: string, tok: string) {
  return prisma.supportConversation.findFirst({ where: { token: tok, shopDomain: shop }, include: { messages: { orderBy: { createdAt: "asc" } } } });
}

export async function getConversation(shop: string, id: string) {
  return prisma.supportConversation.findFirst({ where: { id, shopDomain: shop }, include: { messages: { orderBy: { createdAt: "asc" } } } });
}

export async function listConversations(shop: string, opts: { status?: string | null; q?: string | null; take?: number } = {}) {
  const where: Prisma.SupportConversationWhereInput = { shopDomain: shop };
  if (opts.status && opts.status !== "all") where.status = opts.status === "needs" ? "handoff" : opts.status;
  if (opts.q) {
    const q = opts.q.trim();
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { phone: { contains: q.replace(/\D/g, "") || q } },
      { handoffSummary: { contains: q, mode: "insensitive" } },
      { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
    ];
  }
  const rows = await prisma.supportConversation.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: opts.take ?? 100,
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return rows;
}

export async function countNeedsReply(shop: string): Promise<number> {
  return prisma.supportConversation.count({ where: { shopDomain: shop, status: "handoff" } });
}

export type NewMessage = {
  role: "user" | "assistant" | "staff" | "system";
  content: string;
  meta?: Prisma.InputJsonValue;
  model?: string | null;
  usage?: UsageLike | null;
  latencyMs?: number | null;
  deliveredVia?: string | null;
  createdBy?: string | null;
};

export async function appendMessage(conversationId: string, m: NewMessage): Promise<SupportMessage> {
  const micros = m.usage ? costMicros(m.usage) : 0;
  const [msg] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: {
        conversationId,
        role: m.role,
        content: m.content,
        meta: m.meta,
        model: m.model ?? null,
        inputTokens: m.usage ? m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) : 0,
        outputTokens: m.usage?.output_tokens ?? 0,
        latencyMs: m.latencyMs ?? null,
        deliveredVia: m.deliveredVia ?? null,
        createdBy: m.createdBy ?? null,
      },
    }),
    prisma.supportConversation.update({
      where: { id: conversationId },
      data: {
        messageCount: { increment: 1 },
        inputTokens: { increment: m.usage ? m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) : 0 },
        outputTokens: { increment: m.usage?.output_tokens ?? 0 },
        costMicros: { increment: micros },
        ...(m.role === "user" ? { lastUserAt: new Date() } : {}),
        ...(m.role === "staff" ? { lastStaffAt: new Date() } : {}),
      },
    }),
  ]);
  return msg;
}

export async function setConversationStatus(shop: string, id: string, status: ConversationStatus) {
  return prisma.supportConversation.update({ where: { id }, data: { status } });
}

export async function flagConversation(shop: string, id: string, flagged: boolean, note: string | null) {
  return prisma.supportConversation.update({ where: { id }, data: { flagged, flagNote: note } });
}

export async function setContact(shop: string, id: string, c: { name?: string | null; email?: string | null; phone?: string | null }) {
  const data: Prisma.SupportConversationUpdateInput = {};
  if (c.name?.trim()) data.name = c.name.trim().slice(0, 80);
  if (c.email?.trim()) data.email = c.email.trim().toLowerCase().slice(0, 120);
  const phone = c.phone ? normalizePhone(c.phone) : null;
  if (phone) data.phone = phone;
  return prisma.supportConversation.update({ where: { id }, data });
}

// ───────────────────────────── 用量 / 限速 ─────────────────────────────

export async function recordUsage(shop: string, usage: UsageLike, now = new Date()) {
  const day = dayKey(now);
  const micros = costMicros(usage);
  const inTok = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  await prisma.supportUsageDay.upsert({
    where: { shopDomain_day: { shopDomain: shop, day } },
    create: { shopDomain: shop, day, requests: 1, inputTokens: inTok, outputTokens: usage.output_tokens, costMicros: micros },
    update: { requests: { increment: 1 }, inputTokens: { increment: inTok }, outputTokens: { increment: usage.output_tokens }, costMicros: { increment: micros } },
  });
}

export async function spentTodayCents(shop: string, now = new Date()): Promise<number> {
  const row = await prisma.supportUsageDay.findUnique({ where: { shopDomain_day: { shopDomain: shop, day: dayKey(now) } } });
  return row ? microsToCents(row.costMicros) : 0;
}

export async function usageLastDays(shop: string, days = 14) {
  return prisma.supportUsageDay.findMany({ where: { shopDomain: shop }, orderBy: { day: "desc" }, take: days });
}

export async function rateCounts(shop: string, visitorId: string, ipHash: string | null, conversationId: string | null, now = new Date()) {
  const since = new Date(now.getTime() - 3600_000);
  const [visitor, ip, turns] = await Promise.all([
    prisma.supportMessage.count({ where: { role: "user", createdAt: { gte: since }, conversation: { shopDomain: shop, visitorId } } }),
    ipHash ? prisma.supportMessage.count({ where: { role: "user", createdAt: { gte: since }, conversation: { shopDomain: shop, ipHash } } }) : Promise.resolve(0),
    conversationId ? prisma.supportMessage.count({ where: { conversationId, role: "user" } }) : Promise.resolve(0),
  ]);
  return { visitorLastHour: visitor, ipLastHour: ip, turnsInConversation: turns };
}

// ───────────────────────────── 通知（Klaviyo 事件 → Flow） ─────────────────────────────

export function adminConversationUrl(id: string) {
  const base = (process.env.APP_ADMIN_URL ?? "https://admin.shopify.com/store/borderlineequipment/apps/borderlineai").replace(/\/$/, "");
  return `${base}/app/support/${id}`;
}

export function chatResumeUrl(tok: string) {
  const base = (process.env.STOREFRONT_BASE ?? "https://borderlinestore.ca").replace(/\/$/, "");
  return `${base}/?bl-chat=${encodeURIComponent(tok)}`;
}

/** 转人工：给每个店员邮箱发 "Support Handoff" 事件（Klaviyo Flow 发邮件）。 */
export async function notifyHandoff(shop: string, conversationId: string): Promise<{ sent: number; skipped: number }> {
  const [cfg, c] = await Promise.all([getSupportConfig(shop), getConversation(shop, conversationId)]);
  if (!c) return { sent: 0, skipped: 0 };
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const transcript = c.messages
    .filter((m) => m.role !== "system")
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Customer" : m.role === "staff" ? "Staff" : "Assistant"}: ${m.content}`)
    .join("\n");
  const props = {
    conversation_id: c.id,
    admin_url: adminConversationUrl(c.id),
    customer_name: c.name ?? "",
    customer_email: c.email ?? "",
    customer_phone: c.phone ?? "",
    question: lastUser.slice(0, 1000),
    summary: c.handoffSummary ?? "",
    reason: c.handoffReason ?? "",
    page_url: c.pageUrl ?? "",
    locale: c.locale,
    transcript: transcript.slice(0, 4000),
  };
  let sent = 0;
  let skipped = 0;
  for (const email of cfg.staffEmails) {
    const r = await sendKlaviyoEvent("Support Handoff", { email }, props, `handoff:${c.id}:${email}:${c.handoffAt?.getTime() ?? 0}`);
    if (r.ok) sent++;
    else skipped++;
  }
  return { sent, skipped };
}

/** 店员回复：存消息 + 给客人发 "Support Reply" 事件（邮件；短信由 Klaviyo 在有同意且开通 SMS 时发）。 */
export async function staffReply(shop: string, conversationId: string, text: string, by: string, via: "email" | "sms" | "none" = "email") {
  const c = await getConversation(shop, conversationId);
  if (!c) throw new Error("Conversation not found");
  const body = text.trim();
  if (!body) throw new Error("Reply is empty");
  const msg = await appendMessage(conversationId, { role: "staff", content: body, createdBy: by, deliveredVia: via });
  await prisma.supportConversation.update({ where: { id: conversationId }, data: { status: "answered", assignedTo: by } });
  let delivery: { ok: boolean; skipped: boolean; error?: string } = { ok: false, skipped: true, error: "no contact" };
  if (via !== "none" && (c.email || c.phone)) {
    const lastUser = [...c.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const [first, ...rest] = (c.name ?? "").split(" ");
    delivery = await sendKlaviyoEvent(
      "Support Reply",
      { email: via === "sms" ? null : c.email, phone: via === "sms" ? c.phone : null, firstName: first || null, lastName: rest.join(" ") || null },
      { conversation_id: c.id, reply: body, question: lastUser.slice(0, 1000), staff: by, chat_url: chatResumeUrl(c.token), locale: c.locale, channel: via },
      `reply:${msg.id}`,
    );
  }
  return { message: msg, delivery };
}
