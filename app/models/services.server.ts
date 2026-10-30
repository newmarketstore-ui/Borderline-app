// 服务工单：门店 / 目录（首次按海报种子建）、建单、排队与预计日期、状态流转（带历史）、通知、订单自动关联。
import { randomBytes } from "node:crypto";
import type { Prisma, ServiceStore, ServiceTicket, ServiceType } from "@prisma/client";

import prisma from "../db.server";
import { sendKlaviyoEvent } from "../lib/klaviyo.server";
import {
  computeEta,
  DEFAULT_ETA_RULES,
  isOpenStatus,
  NEXT_STATUSES,
  normalizeEmail,
  normalizePhone,
  parseEtaRules,
  SERVICE_TYPE_SEED,
  STATUS_LABEL,
  STORE_SEED,
  TAG_HOLDING_STATUSES,
  validateTicketInput,
  type EtaResult,
  type ServiceTypeSeed,
  type TicketInput,
  type TicketStatus,
} from "../lib/serviceRules";

// ── 门店 / 目录 ─────────────────────────────────────────────────────────────

export async function getStores(shop: string, opts: { includeInactive?: boolean } = {}): Promise<ServiceStore[]> {
  let rows = await prisma.serviceStore.findMany({ where: { shopDomain: shop }, orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) {
    await prisma.serviceStore.createMany({
      data: STORE_SEED.map((s) => ({ shopDomain: shop, ...s, etaRules: DEFAULT_ETA_RULES as unknown as Prisma.InputJsonValue })),
      skipDuplicates: true,
    });
    rows = await prisma.serviceStore.findMany({ where: { shopDomain: shop }, orderBy: { sortOrder: "asc" } });
  }
  return opts.includeInactive ? rows : rows.filter((r) => r.active);
}

export async function getStore(shop: string, key: string): Promise<ServiceStore | null> {
  const stores = await getStores(shop, { includeInactive: true });
  return stores.find((s) => s.key === key) ?? null;
}

export async function getCatalog(shop: string, opts: { includeInactive?: boolean } = {}): Promise<ServiceType[]> {
  let rows = await prisma.serviceType.findMany({ where: { shopDomain: shop }, orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) {
    await prisma.serviceType.createMany({ data: SERVICE_TYPE_SEED.map((s) => ({ shopDomain: shop, ...s })), skipDuplicates: true });
    rows = await prisma.serviceType.findMany({ where: { shopDomain: shop }, orderBy: { sortOrder: "asc" } });
  }
  return opts.includeInactive ? rows : rows.filter((r) => r.active);
}

export const toSeedShape = (t: ServiceType): ServiceTypeSeed => ({
  key: t.key,
  name: t.name,
  category: t.category as ServiceTypeSeed["category"],
  durationMin: t.durationMin,
  priceCents: t.priceCents,
  memberPriceCents: t.memberPriceCents,
  needsEdgeAngle: t.needsEdgeAngle,
  needsBodyMetrics: t.needsBodyMetrics,
  stores: t.stores as ServiceTypeSeed["stores"],
  sortOrder: t.sortOrder,
});

export async function catalogForStore(shop: string, storeKey: string): Promise<ServiceType[]> {
  return (await getCatalog(shop)).filter((t) => t.stores.includes(storeKey));
}

// ── 排队 / 预计日期 ──────────────────────────────────────────────────────────

export async function queueAhead(shop: string, storeKey: string, before: Date = new Date()): Promise<number> {
  return prisma.serviceTicket.count({
    where: { shopDomain: shop, storeKey, status: { in: ["received", "in_progress", "on_hold"] }, createdAt: { lt: before } },
  });
}

export async function etaForStore(shop: string, store: ServiceStore, now = new Date()): Promise<EtaResult> {
  const ahead = await queueAhead(shop, store.key, now);
  return computeEta(ahead, parseEtaRules(store.etaRules), now, store.timezone);
}

/** 日期字符串 YYYY-MM-DD（当地）→ 当天 closeHour 的时间点（存 etaAt）。 */
export function etaDateToInstant(date: string, store: Pick<ServiceStore, "timezone" | "closeHour">): Date {
  const [y, m, d] = date.split("-").map(Number);
  // 先假设当地 = UTC 建一个时间点，再用该时间点在店时区的"小时差"修正一次（多伦多 -4/-5 小时）
  const guess = new Date(Date.UTC(y, m - 1, d, store.closeHour));
  const localHour = Number(new Intl.DateTimeFormat("en-CA", { timeZone: store.timezone, hour: "2-digit", hour12: false }).format(guess)) % 24;
  let diff = store.closeHour - localHour;
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return new Date(guess.getTime() + diff * 3600000);
}

// ── 建单 ───────────────────────────────────────────────────────────────────

export type CreateTicketParams = TicketInput & {
  shop: string;
  din: string | null;
  edgeAngle: string | null;
  stanceFront: string | null;
  stanceBack: string | null;
  stanceWidth: string | null;
  boardInfo: string | null;
  customerNotes: string | null;
  consentSms: boolean;
  consentEmail: boolean;
  source: "qr" | "staff" | "order";
  shopifyCustomerId?: string | null;
  createdBy?: string;
};

export type CreateTicketResult = { ok: true; ticket: ServiceTicket; eta: EtaResult } | { ok: false; errors: string[] };

const newToken = () => randomBytes(12).toString("base64url");

export async function createTicket(p: CreateTicketParams): Promise<CreateTicketResult> {
  const store = await getStore(p.shop, p.storeKey);
  const catalog = (await catalogForStore(p.shop, p.storeKey)).map(toSeedShape);
  const errors = validateTicketInput(p, catalog, store);
  if (errors.length || !store) return { ok: false, errors };
  const tag = p.tagNumber as number;
  const holder = await prisma.serviceTicket.findFirst({
    where: { shopDomain: p.shop, storeKey: p.storeKey, tagNumber: tag, status: { in: TAG_HOLDING_STATUSES } },
    select: { id: true, customerName: true, createdAt: true },
  });
  if (holder) return { ok: false, errors: [`Tag ${tag} is already in use by another ticket. Please ask staff for a different tag.`] };

  const now = new Date();
  const eta = await etaForStore(p.shop, store, now);
  const selected = catalog.filter((c) => p.serviceKeys.includes(c.key));
  const email = normalizeEmail(p.email);
  const phone = p.phone ? normalizePhone(p.phone) : null;
  const member = await findMember(p.shop, p.shopifyCustomerId ?? null, email, phone);
  const ticket = await prisma.serviceTicket.create({
    data: {
      shopDomain: p.shop,
      storeKey: p.storeKey,
      tagNumber: tag,
      token: newToken(),
      status: "received",
      customerName: p.customerName.trim(),
      email,
      phone,
      shopifyCustomerId: p.shopifyCustomerId ?? member?.shopifyCustomerId ?? null,
      memberId: member?.id ?? null,
      services: selected.map((s) => ({ key: s.key, name: s.name, qty: 1, durationMin: s.durationMin })),
      equipment: p.equipment,
      boardInfo: p.boardInfo,
      edgeAngle: p.edgeAngle,
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      din: p.din,
      stanceFront: p.stanceFront,
      stanceBack: p.stanceBack,
      stanceWidth: p.stanceWidth,
      customerNotes: p.customerNotes,
      source: p.source,
      consentSms: p.consentSms,
      consentEmail: p.consentEmail,
      etaAt: etaDateToInstant(eta.date, store),
      etaNote: `${eta.label} (${eta.ahead} ahead)`,
      history: [{ at: now.toISOString(), status: "received", by: p.createdBy ?? p.source, note: `eta ${eta.date}` }],
    },
  });
  return { ok: true, ticket, eta };
}

async function findMember(shop: string, customerGid: string | null, email: string | null, phone: string | null) {
  if (customerGid) {
    const m = await prisma.member.findUnique({ where: { shopifyCustomerId: customerGid } });
    if (m) return m;
  }
  if (email) {
    const m = await prisma.member.findFirst({ where: { shopDomain: shop, email: { equals: email, mode: "insensitive" } } });
    if (m) return m;
  }
  if (phone) {
    const m = await prisma.member.findFirst({ where: { shopDomain: shop, phone: { endsWith: phone.slice(-10) } } });
    if (m) return m;
  }
  return null;
}

// ── 查询 ───────────────────────────────────────────────────────────────────

export async function listTickets(shop: string, opts: { storeKey?: string | null; status?: string | null; q?: string | null; take?: number }) {
  const where: Prisma.ServiceTicketWhereInput = { shopDomain: shop };
  if (opts.storeKey) where.storeKey = opts.storeKey;
  if (opts.status === "open") where.status = { in: ["received", "in_progress", "on_hold"] };
  else if (opts.status === "ready") where.status = "ready";
  else if (opts.status === "done") where.status = { in: ["picked_up", "cancelled"] };
  else if (opts.status) where.status = opts.status;
  if (opts.q) {
    const q = opts.q.trim();
    const n = Number(q);
    where.OR = [
      ...(Number.isInteger(n) ? [{ tagNumber: n }] : []),
      { customerName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q.replace(/\D/g, "") || q } },
      { orderName: { contains: q, mode: "insensitive" } },
    ];
  }
  return prisma.serviceTicket.findMany({ where, orderBy: [{ createdAt: "asc" }], take: opts.take ?? 300 });
}

export async function getTicket(shop: string, id: string) {
  return prisma.serviceTicket.findFirst({ where: { shopDomain: shop, id }, include: { notifications: { orderBy: { createdAt: "desc" }, take: 20 } } });
}

export async function getTicketByToken(token: string) {
  return prisma.serviceTicket.findUnique({ where: { token } });
}

/** 顾客端：按客户 GID / 邮箱 / 手机找他的工单（账户页用） */
export async function ticketsForCustomer(shop: string, ids: { customerGid?: string | null; email?: string | null; phone?: string | null }, take = 20) {
  const or: Prisma.ServiceTicketWhereInput[] = [];
  if (ids.customerGid) or.push({ shopifyCustomerId: ids.customerGid });
  const email = normalizeEmail(ids.email);
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  const phone = ids.phone ? normalizePhone(ids.phone) : null;
  if (phone && phone.length >= 10) or.push({ phone: { endsWith: phone.slice(-10) } });
  if (!or.length) return [];
  return prisma.serviceTicket.findMany({ where: { shopDomain: shop, OR: or }, orderBy: { createdAt: "desc" }, take });
}

// ── 状态流转 ───────────────────────────────────────────────────────────────

export async function setStatus(shop: string, id: string, next: TicketStatus, by: string, note?: string | null) {
  const t = await prisma.serviceTicket.findFirst({ where: { shopDomain: shop, id } });
  if (!t) throw new Error("Ticket not found");
  const allowed = NEXT_STATUSES[t.status as TicketStatus] ?? [];
  if (!allowed.includes(next)) throw new Error(`Cannot go from ${STATUS_LABEL[t.status as TicketStatus] ?? t.status} to ${STATUS_LABEL[next]}`);
  const now = new Date();
  const data: Prisma.ServiceTicketUpdateInput = {
    status: next,
    history: [...((t.history as unknown[]) ?? []), { at: now.toISOString(), status: next, by, note: note ?? null }] as Prisma.InputJsonValue,
  };
  if (next === "in_progress" && !t.startedAt) data.startedAt = now;
  if (next === "ready") data.readyAt = now;
  if (next === "picked_up") data.pickedUpAt = now;
  const updated = await prisma.serviceTicket.update({ where: { id }, data });
  if (next === "ready") await notify(updated, "ready", by);
  return updated;
}

export async function updateTicketFields(shop: string, id: string, fields: Prisma.ServiceTicketUpdateInput, by: string) {
  const t = await prisma.serviceTicket.findFirst({ where: { shopDomain: shop, id } });
  if (!t) throw new Error("Ticket not found");
  return prisma.serviceTicket.update({
    where: { id },
    data: { ...fields, history: [...((t.history as unknown[]) ?? []), { at: new Date().toISOString(), status: t.status, by, note: "edited" }] as Prisma.InputJsonValue },
  });
}

/** 延期：改预计日期 + 发"抱歉"通知（老板 10/30） */
export async function delayTicket(shop: string, id: string, newDate: string, by: string, message?: string | null) {
  const t = await prisma.serviceTicket.findFirst({ where: { shopDomain: shop, id } });
  if (!t) throw new Error("Ticket not found");
  const store = await getStore(shop, t.storeKey);
  if (!store) throw new Error("Store not found");
  const updated = await prisma.serviceTicket.update({
    where: { id },
    data: {
      etaAt: etaDateToInstant(newDate, store),
      etaNote: `delayed by staff${message ? `: ${message}` : ""}`,
      delayCount: { increment: 1 },
      history: [...((t.history as unknown[]) ?? []), { at: new Date().toISOString(), status: t.status, by, note: `delayed to ${newDate}` }] as Prisma.InputJsonValue,
    },
  });
  await notify(updated, "delayed", by, { message: message ?? null });
  return updated;
}

// ── 通知（Klaviyo 事件）────────────────────────────────────────────────────

export type NotifyKind = "received" | "ready" | "delayed" | "reminder" | "custom";
const METRIC: Record<NotifyKind, string> = {
  received: "Service Received",
  ready: "Service Ready",
  delayed: "Service Delayed",
  reminder: "Service Pickup Reminder",
  custom: "Service Message",
};

export function statusUrl(token: string, proxyBase = process.env.SERVICE_STATUS_BASE ?? "https://borderlinestore.ca/apps/loyalty-1") {
  return `${proxyBase.replace(/\/$/, "")}/service/t/${token}`;
}

export async function notify(t: ServiceTicket, kind: NotifyKind, by: string, extra: Record<string, unknown> = {}) {
  const store = await getStore(t.shopDomain, t.storeKey);
  const services = (t.services as Array<{ name: string }>).map((s) => s.name).join(", ");
  const etaDate = t.etaAt ? new Intl.DateTimeFormat("en-CA", { timeZone: store?.timezone ?? "America/Toronto", dateStyle: "full" }).format(t.etaAt) : null;
  const props = {
    ticket_id: t.id,
    tag_number: t.tagNumber,
    store: store?.name ?? t.storeKey,
    store_address: store?.address ?? null,
    store_hours: store?.hoursText ?? null,
    store_phone: store?.phone ?? null,
    services,
    status: t.status,
    status_label: STATUS_LABEL[t.status as TicketStatus] ?? t.status,
    eta_date: etaDate,
    status_url: statusUrl(t.token),
    customer_name: t.customerName,
    ...extra,
  };
  const [first, ...rest] = t.customerName.split(/\s+/);
  const res = await sendKlaviyoEvent(
    METRIC[kind],
    { email: t.consentEmail ? t.email : null, phone: t.consentSms ? t.phone : null, firstName: first, lastName: rest.join(" ") || null },
    props,
    `${kind}:${t.id}:${t.delayCount}:${t.readyAt?.getTime() ?? 0}:${extra.seq ?? 0}`,
  );
  await prisma.serviceNotification.create({
    data: {
      ticketId: t.id,
      kind,
      channel: res.skipped ? "log" : "klaviyo",
      toEmail: t.consentEmail ? t.email : null,
      toPhone: t.consentSms ? t.phone : null,
      payload: props as Prisma.InputJsonValue,
      ok: res.ok,
      error: res.error ?? null,
      createdBy: by,
    },
  });
  return res;
}

// ── 订单自动关联（可有可无：只为标"已付款"和报表）─────────────────────────────

export async function linkOrderToTickets(
  shop: string,
  order: { orderGid: string; orderName: string | null; email: string | null; phone: string | null; customerGid: string | null; locationId: string | null; at: Date },
): Promise<number> {
  const stores = await getStores(shop, { includeInactive: true });
  const store = order.locationId ? stores.find((s) => s.shopifyLocationId === order.locationId) : null;
  const email = normalizeEmail(order.email);
  const phone = order.phone ? normalizePhone(order.phone) : null;
  const or: Prisma.ServiceTicketWhereInput[] = [];
  if (order.customerGid) or.push({ shopifyCustomerId: order.customerGid });
  if (email) or.push({ email: { equals: email, mode: "insensitive" } });
  if (phone && phone.length >= 10) or.push({ phone: { endsWith: phone.slice(-10) } });
  if (!or.length) return 0;
  const since = new Date(order.at.getTime() - 24 * 60 * 60 * 1000);
  const until = new Date(order.at.getTime() + 24 * 60 * 60 * 1000);
  const res = await prisma.serviceTicket.updateMany({
    where: {
      shopDomain: shop,
      ...(store ? { storeKey: store.key } : {}),
      orderId: null,
      createdAt: { gte: since, lte: until },
      status: { in: ["received", "in_progress", "on_hold", "ready"] },
      OR: or,
    },
    data: { orderId: order.orderGid, orderName: order.orderName, paid: true, ...(order.customerGid ? { shopifyCustomerId: order.customerGid } : {}) },
  });
  return res.count;
}

// ── 设置 ───────────────────────────────────────────────────────────────────

export async function saveStore(shop: string, key: string, data: Partial<Pick<ServiceStore, "name" | "tagMin" | "tagMax" | "techsPerDay" | "openHour" | "closeHour" | "address" | "hoursText" | "phone" | "active" | "shopifyLocationId">> & { etaRules?: unknown }) {
  const { etaRules, ...rest } = data;
  return prisma.serviceStore.update({
    where: { shopDomain_key: { shopDomain: shop, key } },
    data: { ...rest, ...(etaRules !== undefined ? { etaRules: parseEtaRules(etaRules) as unknown as Prisma.InputJsonValue } : {}) },
  });
}

export async function saveServiceType(shop: string, key: string, data: Partial<Pick<ServiceType, "name" | "durationMin" | "priceCents" | "memberPriceCents" | "needsEdgeAngle" | "needsBodyMetrics" | "stores" | "active" | "sortOrder">>) {
  return prisma.serviceType.update({ where: { shopDomain_key: { shopDomain: shop, key } }, data });
}

export const ticketIsOpen = (t: ServiceTicket) => isOpenStatus(t.status);

// ── 取件提醒（sweep 每 10 分钟跑；ready 超过 N 天且 N 天内没提醒过 → 再发一次）────
export async function sendPickupReminders(days = Number(process.env.SERVICE_REMINDER_DAYS ?? 3)): Promise<{ sent: number; errors: number }> {
  if (!Number.isFinite(days) || days <= 0) return { sent: 0, errors: 0 };
  const cutoff = new Date(Date.now() - days * 86400000);
  const due = await prisma.serviceTicket.findMany({
    where: {
      status: "ready",
      readyAt: { lt: cutoff },
      notifications: { none: { kind: "reminder", createdAt: { gte: cutoff } } },
    },
    include: { notifications: { where: { kind: "reminder" }, select: { id: true } } },
    take: 200,
  });
  let sent = 0;
  let errors = 0;
  for (const t of due) {
    try {
      const seq = t.notifications.length + 1;
      const res = await notify(t, "reminder", "system", { seq, days_waiting: Math.floor((Date.now() - (t.readyAt?.getTime() ?? Date.now())) / 86400000) });
      if (res.ok || res.skipped) sent++;
      else errors++;
    } catch (e) {
      errors++;
      console.error(`[services] reminder failed for ${t.id}: ${(e as Error).message}`);
    }
  }
  return { sent, errors };
}
