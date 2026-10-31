// 店面聊天接口（App Proxy：https://<店>/apps/loyalty-1/chat）。
// GET  ?visitor=&conversation=   或 ?token=   → 会话历史（给挂件恢复 / 邮件链接继续）
// POST JSON {visitorId, conversationId?, message, locale, pageUrl?, productHandle?} → 助手回复
import { createHash } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { cleanUserText, isVisitorId, normalizeLocale, rateDecision, UI_TEXT } from "../lib/supportRules";
import { isModuleEnabled } from "../models/modules.server";
import {
  appendMessage,
  ensureConversation,
  getConversationByToken,
  getConversationForVisitor,
  getSupportConfig,
  notifyHandoff,
  rateCounts,
  recordUsage,
  spentTodayCents,
  type SupportConversation,
  type SupportMessage,
} from "../models/support.server";
import { assistantConfigured, runAssistantTurn } from "../models/supportChat.server";
import { authenticate } from "../shopify.server";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function ipHash(request: Request): string | null {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip");
  if (!ip) return null;
  const salt = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32);
}

function publicView(c: SupportConversation & { messages: SupportMessage[] }) {
  return {
    conversationId: c.id,
    status: c.status,
    contactKnown: Boolean(c.email || c.phone),
    locale: c.locale,
    messages: c.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content, at: m.createdAt.toISOString() })),
  };
}

async function proxyCtx(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const cid = url.searchParams.get("logged_in_customer_id");
  return { shop, url, customerGid: cid ? `gid://shopify/Customer/${cid}` : null };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, url } = await proxyCtx(request);
  if (!shop) return json({ error: "no shop" }, 400);
  const tok = url.searchParams.get("token");
  const visitor = url.searchParams.get("visitor");
  const id = url.searchParams.get("conversation");
  let c = null;
  if (tok) c = await getConversationByToken(shop, tok);
  else if (isVisitorId(visitor) && id) c = await getConversationForVisitor(shop, visitor, id);
  if (!c) return json({ error: "not found" }, 404);
  return json(publicView(c));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, customerGid } = await proxyCtx(request);
  if (!shop) return json({ error: "no shop" }, 400);
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const visitorId = body.visitorId;
  if (!isVisitorId(visitorId)) return json({ error: "bad visitor" }, 400);
  const locale = normalizeLocale(typeof body.locale === "string" ? body.locale : null);
  const text = cleanUserText(body.message);
  const t = UI_TEXT[locale];
  if (!text) return json({ error: "empty" }, 400);

  const [enabled, cfg] = await Promise.all([isModuleEnabled(shop, "ai_support"), getSupportConfig(shop)]);
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const hash = ipHash(request);
  const conversation = await ensureConversation({
    shop,
    visitorId,
    conversationId,
    customerGid,
    locale,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 300) : null,
    productHandle: typeof body.productHandle === "string" && body.productHandle ? body.productHandle.slice(0, 120) : null,
    ipHash: hash,
  });

  const [counts, spent] = await Promise.all([rateCounts(shop, visitorId, hash, conversation.id), spentTodayCents(shop)]);
  const gate = rateDecision({
    enabled: enabled && cfg.enabled && assistantConfigured(),
    ...counts,
    spentTodayCents: spent,
    limits: cfg,
  });
  // 用户消息先落库（限速 / 离线时也留着，店员能看到）
  const history = await prisma.supportMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  await appendMessage(conversation.id, { role: "user", content: text });

  if (!gate.ok) {
    const mode = gate.reason === "visitor" || gate.reason === "ip" ? "limited" : gate.reason === "turns" ? "limited" : "offline";
    const reply = gate.reason === "turns" ? t.rate_turns : mode === "limited" ? t.rate_visitor : t.offline;
    return json({ conversationId: conversation.id, mode, reply, status: conversation.status, contactKnown: Boolean(conversation.email || conversation.phone), needsContact: !(conversation.email || conversation.phone) });
  }

  let customer: Parameters<typeof runAssistantTurn>[0]["customer"] = null;
  if (customerGid) {
    const m = await prisma.member.findUnique({ where: { shopifyCustomerId: customerGid } });
    const paid = Boolean(m && m.tier === "paid" && (!m.paidUntil || m.paidUntil > new Date()));
    customer = { loggedIn: true, name: m ? [m.firstName, m.lastName].filter(Boolean).join(" ") || null : conversation.name, email: m?.email ?? conversation.email, isPaidMember: paid };
  }

  try {
    const r = await runAssistantTurn({ shop, conversation, history, userText: text, locale, customer });
    await Promise.all([
      appendMessage(conversation.id, {
        role: "assistant",
        content: r.text,
        model: r.model,
        usage: r.usage,
        latencyMs: r.latencyMs,
        meta: { tools: r.tools, stop: r.stop } as never,
      }),
      recordUsage(shop, r.usage),
    ]);
    const fresh = await prisma.supportConversation.findUnique({ where: { id: conversation.id } });
    const contactKnown = Boolean(fresh?.email || fresh?.phone);
    if (r.handoff && contactKnown) notifyHandoff(shop, conversation.id).catch((e) => console.warn("[support] handoff notify failed:", (e as Error).message));
    return json({ conversationId: conversation.id, mode: "ok", reply: r.text, status: fresh?.status ?? conversation.status, contactKnown, needsContact: r.handoff && !contactKnown });
  } catch (e) {
    console.error("[support] turn failed:", (e as Error).message);
    await appendMessage(conversation.id, { role: "system", content: `assistant error: ${(e as Error).message}`.slice(0, 500) });
    return json({ conversationId: conversation.id, mode: "error", reply: t.error, status: conversation.status, contactKnown: Boolean(conversation.email || conversation.phone), needsContact: true });
  }
};
