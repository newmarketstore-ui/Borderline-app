// 免登录进度页：GET /apps/loyalty-1/service/t/<token>（短信 / 邮件里的链接）
import type { LoaderFunctionArgs } from "react-router";

import { renderMessage, renderStatus } from "../lib/serviceHtml.server";
import { getStore, getTicketByToken, queueAhead } from "../models/services.server";
import { authenticate } from "../shopify.server";

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  const t = params.token ? await getTicketByToken(params.token) : null;
  if (!t) return html(renderMessage("Not found", "We could not find this service ticket. Check the link in your text or email."), 404);
  const store = await getStore(t.shopDomain, t.storeKey);
  if (!store) return html(renderMessage("Not found", "Store not found."), 404);
  const ahead = ["received", "in_progress", "on_hold"].includes(t.status) ? await queueAhead(t.shopDomain, t.storeKey, t.createdAt) : 0;
  return html(renderStatus(t, store, ahead));
};
