// 店面 App Proxy：GET https://<店>/apps/bl-points/me → 这里 /proxy/loyalty/me
// Shopify 校验签名并带上 logged_in_customer_id（没登录为空）。主题 app block（表头积分、购物车提示）用。
import type { LoaderFunctionArgs } from "react-router";

import { getAdminForShop } from "../models/loyalty.server";
import { customerGid, ensureMember, memberSummary } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

const noStore = { "cache-control": "no-store" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const cid = url.searchParams.get("logged_in_customer_id");
  if (!shop) return Response.json({ error: "shop missing" }, { status: 400, headers: noStore });
  if (!cid) return Response.json({ loggedIn: false }, { headers: noStore });
  const admin = () => getAdminForShop(shop);
  const member = await ensureMember(shop, customerGid(cid), admin, { createIfMissing: true, source: "storefront" });
  if (!member) return Response.json({ loggedIn: true, error: "Customer not found" }, { status: 404, headers: noStore });
  const summary = await memberSummary(shop, member, "web", admin);
  return Response.json({ loggedIn: true, ...summary }, { headers: noStore });
};
