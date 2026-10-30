// 顾客账户扩展：GET /api/account/services → 本人的服务工单（按客户 GID / 邮箱 / 手机匹配）
import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { STATUS_LABEL, type TicketStatus } from "../lib/serviceRules";
import { customerGid } from "../models/loyaltyPublic.server";
import { getStores, queueAhead, statusUrl, ticketsForCustomer } from "../models/services.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = sessionToken.dest.replace(/^https?:\/\//, "");
  if (!sessionToken.sub) return cors(Response.json({ error: "Not logged in" }, { status: 401 }));
  const gid = customerGid(sessionToken.sub);
  const member = await prisma.member.findUnique({ where: { shopifyCustomerId: gid }, select: { email: true, phone: true } });
  const stores = await getStores(shop, { includeInactive: true });
  const tickets = await ticketsForCustomer(shop, { customerGid: gid, email: member?.email, phone: member?.phone });
  const out = [];
  for (const t of tickets) {
    const store = stores.find((s) => s.key === t.storeKey);
    const open = ["received", "in_progress", "on_hold"].includes(t.status);
    out.push({
      id: t.id,
      tagNumber: t.tagNumber,
      store: store?.name ?? t.storeKey,
      status: t.status,
      statusLabel: STATUS_LABEL[t.status as TicketStatus] ?? t.status,
      services: (t.services as Array<{ name: string }>).map((s) => s.name),
      etaAt: t.etaAt?.toISOString() ?? null,
      ahead: open ? await queueAhead(shop, t.storeKey, t.createdAt) : 0,
      createdAt: t.createdAt.toISOString(),
      readyAt: t.readyAt?.toISOString() ?? null,
      pickedUpAt: t.pickedUpAt?.toISOString() ?? null,
      statusUrl: statusUrl(t.token),
    });
  }
  return cors(Response.json({ tickets: out }));
};
