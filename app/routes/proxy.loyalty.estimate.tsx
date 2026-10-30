// 店面 App Proxy：GET /apps/bl-points/estimate?cents=12999 → 商品页 / 购物车「这单能赚 N 分」
import type { LoaderFunctionArgs } from "react-router";

import { estimatePoints } from "../models/loyaltyPublic.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  if (!shop) return Response.json({ error: "shop missing" }, { status: 400 });
  const cents = Number(url.searchParams.get("cents") ?? "0");
  const est = await estimatePoints(shop, Number.isFinite(cents) ? cents : 0);
  // 规则很少变：允许 CDN / 浏览器缓存 5 分钟
  return Response.json(est, { headers: { "cache-control": "public, max-age=300" } });
};
