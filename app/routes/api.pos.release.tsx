// POS 扩展：POST /api/pos/release  JSON { redemptionId }
// 当场抵扣已扣分、但 applyCartDiscount 在 POS 上失败了 → 立刻退分（不等 sweep 到期）。只对 issued 的 cart_discount 有效。
import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { staffIdentity } from "../models/loyalty.server";
import { releaseRedemption } from "../models/redemption.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken, cors } = await authenticate.admin(request);
  if (request.method !== "POST") return cors(Response.json({ error: "POST only" }, { status: 405 }));
  const body = (await request.json().catch(() => ({}))) as { redemptionId?: string };
  if (!body.redemptionId) return cors(Response.json({ error: "redemptionId required" }, { status: 400 }));
  const r = await prisma.redemption.findUnique({ where: { id: body.redemptionId }, include: { member: true } });
  if (!r || r.member.shopDomain !== session.shop) return cors(Response.json({ error: "Not found" }, { status: 404 }));
  if (r.method !== "cart_discount") return cors(Response.json({ error: "Only cart discounts can be released here" }, { status: 400 }));
  const released = await releaseRedemption(r.id, "cancelled", `pos:${staffIdentity(session, sessionToken)}`, "cart discount could not be applied on POS");
  return cors(Response.json({ ok: true, released }));
};

export const loader = async ({ request }: ActionFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(Response.json({ error: "POST only" }, { status: 405 }));
};
