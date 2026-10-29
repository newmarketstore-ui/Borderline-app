// 顾客账户扩展（新版客户账户 shopify.com/…/account）：GET /api/account/me
// 鉴权：customer account UI extension 的 session token，sub = 顾客 ID。只回答本人。
import type { LoaderFunctionArgs } from "react-router";

import { getAdminForShop } from "../models/loyalty.server";
import { customerGid, ensureMember, memberSummary } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = sessionToken.dest.replace(/^https?:\/\//, "");
  if (!sessionToken.sub) return cors(Response.json({ error: "Not logged in" }, { status: 401 }));
  const admin = () => getAdminForShop(shop);
  const member = await ensureMember(shop, customerGid(sessionToken.sub), admin, { createIfMissing: true, source: "account" });
  if (!member) return cors(Response.json({ error: "Customer not found" }, { status: 404 }));
  return cors(Response.json(await memberSummary(shop, member, "web", admin)));
};
