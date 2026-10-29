// 顾客账户扩展：POST /api/account/redeem  JSON { points, idempotencyKey } → 本人积分换 Store Credit
import type { ActionFunctionArgs } from "react-router";

import { formatCents } from "../lib/redeemMath";
import { getAdminForShop } from "../models/loyalty.server";
import { customerGid, ensureMember, KEY_RE, redeemForMember } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  if (request.method !== "POST") return cors(Response.json({ error: "POST only" }, { status: 405 }));
  const shop = sessionToken.dest.replace(/^https?:\/\//, "");
  if (!sessionToken.sub) return cors(Response.json({ error: "Not logged in" }, { status: 401 }));
  const body = (await request.json().catch(() => ({}))) as { points?: number; idempotencyKey?: string };
  const points = Number(body.points);
  if (!Number.isInteger(points) || points <= 0) return cors(Response.json({ error: "points must be a positive whole number" }, { status: 400 }));
  const key = body.idempotencyKey && KEY_RE.test(body.idempotencyKey) ? body.idempotencyKey : null;
  const admin = () => getAdminForShop(shop);
  const gid = customerGid(sessionToken.sub);
  const member = await ensureMember(shop, gid, admin, { createIfMissing: true, source: "account" });
  if (!member) return cors(Response.json({ error: "Customer not found" }, { status: 404 }));
  const res = await redeemForMember({ shop, member, points, channel: "web", issuedBy: `customer:${gid}`, idempotencyKey: key, admin });
  if (!res.ok) return cors(Response.json({ ok: false, error: res.error }, { status: 422 }));
  const r = res.redemption;
  return cors(
    Response.json({
      ok: true,
      applied: res.applied,
      method: r.method,
      status: r.status,
      points: r.points,
      amount: formatCents(r.amountCents),
      code: r.discountCode,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }),
  );
};

export const loader = async ({ request }: ActionFunctionArgs) => {
  const { cors } = await authenticate.public.customerAccount(request);
  return cors(Response.json({ error: "POST only" }, { status: 405 }));
};
