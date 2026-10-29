// POS 扩展：POST /api/pos/redeem  JSON { customerId, points, idempotencyKey }
// 默认发 Store Credit（店员随后在 POS 收款里选 Store credit）；规则设成折扣码时返回码。
import type { ActionFunctionArgs } from "react-router";

import { formatCents } from "../lib/redeemMath";
import { getAdminForShop, getLoyaltySettings, staffIdentity } from "../models/loyalty.server";
import { customerGid, ensureMember, KEY_RE, redeemForMember } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken, cors } = await authenticate.admin(request);
  if (request.method !== "POST") return cors(Response.json({ error: "POST only" }, { status: 405 }));
  const body = (await request.json().catch(() => ({}))) as {
    customerId?: string;
    points?: number;
    idempotencyKey?: string;
    mode?: "store_credit" | "cart_discount";
    maxAmountCents?: number;
  };
  const points = Number(body.points);
  if (!body.customerId || !Number.isInteger(points) || points <= 0)
    return cors(Response.json({ error: "customerId and a positive whole number of points are required" }, { status: 400 }));
  const key = body.idempotencyKey && KEY_RE.test(body.idempotencyKey) ? body.idempotencyKey : null;
  const admin = () => getAdminForShop(session.shop);
  const member = await ensureMember(session.shop, customerGid(body.customerId), admin, { createIfMissing: true, source: "pos" });
  if (!member) return cors(Response.json({ error: "Customer not found in Shopify" }, { status: 404 }));
  const settings = await getLoyaltySettings(session.shop);
  const mode = body.mode === "cart_discount" ? "cart_discount" : "store_credit";
  if (mode === "cart_discount" && !settings.posAllowCartDiscount)
    return cors(Response.json({ error: "Cart discounts are turned off in Loyalty settings" }, { status: 403 }));
  if (mode === "store_credit" && !settings.posAllowStoreCredit)
    return cors(Response.json({ error: "Store credit redemption is turned off in Loyalty settings" }, { status: 403 }));
  const res = await redeemForMember({
    shop: session.shop,
    member,
    points,
    channel: "pos",
    issuedBy: `pos:${staffIdentity(session, sessionToken)}`,
    idempotencyKey: key,
    admin,
    // store_credit 模式沿用规则里的 redeemMethod（可能是折扣码兜底）；cart_discount 强制当场抵扣
    method: mode === "cart_discount" ? "cart_discount" : undefined,
    maxAmountCents: Number.isFinite(Number(body.maxAmountCents)) ? Number(body.maxAmountCents) : null,
  });
  if (!res.ok) return cors(Response.json({ ok: false, error: res.error }, { status: 422 }));
  const r = res.redemption;
  return cors(
    Response.json({
      ok: true,
      applied: res.applied,
      redemptionId: r.id,
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
