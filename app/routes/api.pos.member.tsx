// POS 扩展：GET /api/pos/member?customerId=<数字或 GID>&channel=pos
// 鉴权：POS UI 扩展的 session token（Authorization: Bearer）走 authenticate.admin，与后台页面同一套。
import type { LoaderFunctionArgs } from "react-router";

import { getAdminForShop } from "../models/loyalty.server";
import { customerGid, ensureMember, memberSummary } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("customerId");
  if (!raw) return cors(Response.json({ error: "customerId required" }, { status: 400 }));
  const gid = customerGid(raw);
  const admin = () => getAdminForShop(session.shop);
  const member = await ensureMember(session.shop, gid, admin, { createIfMissing: true, source: "pos" });
  if (!member) return cors(Response.json({ error: "Customer not found in Shopify" }, { status: 404 }));
  const summary = await memberSummary(session.shop, member, "pos", admin);
  return cors(Response.json(summary));
};
