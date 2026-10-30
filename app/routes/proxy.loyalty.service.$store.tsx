// 扫码表单：GET https://<店>/apps/loyalty-1/service/<rh|ott|nmk> → 表单；POST → 建工单 + 确认页 + 收件通知。
// 走 App Proxy：Shopify 校验签名，登录顾客会带 logged_in_customer_id（自动挂到账户）。
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { renderConfirmation, renderIntakeForm, renderMessage, type FormValues } from "../lib/serviceHtml.server";
import { catalogForStore, createTicket, etaForStore, getStore, notify, statusUrl } from "../models/services.server";
import { authenticate } from "../shopify.server";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function ctx(request: Request, storeKey: string | undefined) {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const store = storeKey ? await getStore(shop, storeKey) : null;
  const cid = url.searchParams.get("logged_in_customer_id");
  return { shop, store, customerGid: cid ? `gid://shopify/Customer/${cid}` : null };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, store } = await ctx(request, params.store);
  if (!shop || !store || !store.active) return html(renderMessage("Store not found", "This drop-off link is not valid. Please ask staff for the right QR code."), 404);
  const [catalog, eta] = await Promise.all([catalogForStore(shop, store.key), etaForStore(shop, store)]);
  return html(renderIntakeForm({ store, catalog, values: {}, errors: [], eta }));
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, store, customerGid } = await ctx(request, params.store);
  if (!shop || !store || !store.active) return html(renderMessage("Store not found", "This drop-off link is not valid."), 404);
  const form = await request.formData();
  const str = (k: string) => {
    const v = String(form.get(k) ?? "").trim();
    return v || null;
  };
  const num = (k: string) => {
    const v = str(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const values: FormValues = Object.fromEntries(Array.from(form.entries()).filter(([k]) => k !== "services").map(([k, v]) => [k, String(v)]));
  values.services = form.getAll("services").map(String);
  values.consentSms = form.get("consentSms") ? "1" : "0";
  values.consentEmail = form.get("consentEmail") ? "1" : "0";

  const res = await createTicket({
    shop,
    storeKey: store.key,
    tagNumber: num("tagNumber"),
    customerName: str("customerName") ?? "",
    email: str("email"),
    phone: str("phone"),
    serviceKeys: values.services,
    equipment: str("equipment"),
    heightCm: num("heightCm"),
    weightKg: num("weightKg"),
    din: str("din"),
    edgeAngle: str("edgeAngle"),
    stanceFront: str("stanceFront"),
    stanceBack: str("stanceBack"),
    stanceWidth: str("stanceWidth"),
    boardInfo: str("boardInfo"),
    customerNotes: str("customerNotes"),
    consentSms: values.consentSms === "1",
    consentEmail: values.consentEmail === "1",
    source: "qr",
    shopifyCustomerId: customerGid,
    createdBy: customerGid ? `customer:${customerGid}` : "qr",
  });
  if (!res.ok) {
    const [catalog, eta] = await Promise.all([catalogForStore(shop, store.key), etaForStore(shop, store)]);
    return html(renderIntakeForm({ store, catalog, values, errors: res.errors, eta }), 422);
  }
  // 收件确认（短信 / 邮件带进度链接）；发送失败不影响建单
  notify(res.ticket, "received", "system").catch((e) => console.warn("[services] received notify failed:", (e as Error).message));
  return html(renderConfirmation(res.ticket, store, statusUrl(res.ticket.token), res.eta.label));
};
