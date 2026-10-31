// 客人留联系方式 / 留言给店员（App Proxy POST https://<店>/apps/loyalty-1/chat/handoff）
import type { ActionFunctionArgs } from "react-router";

import { cleanUserText, isEmail, isVisitorId, normalizeLocale, normalizePhone, UI_TEXT } from "../lib/supportRules";
import { appendMessage, ensureConversation, notifyHandoff, setContact } from "../models/support.server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const loader = async () => json({ error: "POST only" }, 405);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  if (!shop) return json({ error: "no shop" }, 400);
  const cid = url.searchParams.get("logged_in_customer_id");
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const visitorId = body.visitorId;
  if (!isVisitorId(visitorId)) return json({ error: "bad visitor" }, 400);
  const locale = normalizeLocale(typeof body.locale === "string" ? body.locale : null);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const message = cleanUserText(body.message);
  if (email && !isEmail(email)) return json({ error: locale === "fr" ? "Courriel invalide" : "Please enter a valid email" }, 422);
  if (!email && !phone) return json({ error: locale === "fr" ? "Il nous faut un courriel ou un téléphone" : "We need an email or a phone number" }, 422);

  const conversation = await ensureConversation({
    shop,
    visitorId,
    conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
    customerGid: cid ? `gid://shopify/Customer/${cid}` : null,
    locale,
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 300) : null,
    productHandle: typeof body.productHandle === "string" && body.productHandle ? body.productHandle.slice(0, 120) : null,
  });
  await setContact(shop, conversation.id, { name, email: email || null, phone });
  if (message) await appendMessage(conversation.id, { role: "user", content: message });
  await prisma.supportConversation.update({
    where: { id: conversation.id },
    data: { status: "handoff", handoffAt: new Date(), handoffReason: conversation.handoffReason ?? "customer_form", handoffSummary: conversation.handoffSummary ?? message.slice(0, 500) },
  });
  const n = await notifyHandoff(shop, conversation.id).catch((e) => {
    console.warn("[support] handoff notify failed:", (e as Error).message);
    return { sent: 0, skipped: 0 };
  });
  return json({ ok: true, conversationId: conversation.id, reply: UI_TEXT[locale].handoff_done, notified: n.sent });
};
