// 店面 App Proxy：POST /apps/loyalty/redeem  JSON { points, idempotencyKey } → 登录顾客本人兑 Store Credit
import type { ActionFunctionArgs } from "react-router";

import { formatCents } from "../lib/redeemMath";
import { getAdminForShop } from "../models/loyalty.server";
import { customerGid, ensureMember, KEY_RE, redeemForMember } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

const noStore = { "cache-control": "no-store" };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers: noStore });
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const cid = url.searchParams.get("logged_in_customer_id");
  if (!shop) return Response.json({ error: "shop missing" }, { status: 400, headers: noStore });
  if (!cid) return Response.json({ error: "Please log in to redeem points" }, { status: 401, headers: noStore });
  const body = (await request.json().catch(() => ({}))) as { points?: number; idempotencyKey?: string };
  const points = Number(body.points);
  if (!Number.isInteger(points) || points <= 0) return Response.json({ error: "points must be a positive whole number" }, { status: 400, headers: noStore });
  const key = body.idempotencyKey && KEY_RE.test(body.idempotencyKey) ? body.idempotencyKey : null;
  const admin = () => getAdminForShop(shop);
  const gid = customerGid(cid);
  const member = await ensureMember(shop, gid, admin, { createIfMissing: true, source: "storefront" });
  if (!member) return Response.json({ error: "Customer not found" }, { status: 404, headers: noStore });
  const res = await redeemForMember({ shop, member, points, channel: "web", issuedBy: `customer:${gid}`, idempotencyKey: key, admin });
  if (!res.ok) return Response.json({ ok: false, error: res.error }, { status: 422, headers: noStore });
  const r = res.redemption;
  return Response.json(
    {
      ok: true,
      applied: res.applied,
      method: r.method,
      status: r.status,
      points: r.points,
      amount: formatCents(r.amountCents),
      code: r.discountCode,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    },
    { headers: noStore },
  );
};

export const loader = async () => Response.json({ error: "POST only" }, { status: 405, headers: noStore });
