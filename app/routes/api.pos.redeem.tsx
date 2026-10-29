// POS 扩展：POST /api/pos/redeem  JSON { customerId, points, idempotencyKey }
// 默认发 Store Credit（店员随后在 POS 收款里选 Store credit）；规则设成折扣码时返回码。
import type { ActionFunctionArgs } from "react-router";

import { formatCents } from "../lib/redeemMath";
import { getAdminForShop, staffIdentity } from "../models/loyalty.server";
import { customerGid, ensureMember, KEY_RE, redeemForMember } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken, cors } = await authenticate.admin(request);
  if (request.method !== "POST") return cors(Response.json({ error: "POST only" }, { status: 405 }));
  const body = (await request.json().catch(() => ({}))) as { customerId?: string; points?: number; idempotencyKey?: string };
  const points = Number(body.points);
  if (!body.customerId || !Number.isInteger(points) || points <= 0)
    return cors(Response.json({ error: "customerId and a positive whole number of points are required" }, { status: 400 }));
  const key = body.idempotencyKey && KEY_RE.test(body.idempotencyKey) ? body.idempotencyKey : null;
  const admin = () => getAdminForShop(session.shop);
  const member = await ensureMember(session.shop, customerGid(body.customerId), admin, { createIfMissing: true, source: "pos" });
  if (!member) return cors(Response.json({ error: "Customer not found in Shopify" }, { status: 404 }));
  const res = await redeemForMember({
    shop: session.shop,
    member,
    points,
    channel: "pos",
    issuedBy: `pos:${staffIdentity(session, sessionToken)}`,
    idempotencyKey: key,
    admin,
  });
  if (!res.ok) return cors(Response.json({ ok: false, error: res.error }, { status: 422 }));
  const r = res.redemption;
  return cors(
    Response.json({
      ok: true,
      applied: res.applied,
      method: r.method,
      status: r.status,
      points: r.points,
      amountCents: r.amountCents,
      amount: formatCents(r.amountCents),
      code: r.discountCode,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }),
  );
};

export const loader = async ({ request }: ActionFunctionArgs) => {
  const { cors } = await authenticate.admin(request);
  return cors(Response.json({ error: "POST only" }, { status: 405 }));
};
