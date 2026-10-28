// 给 Python 分析管道读手动数据的服务端到服务端导出接口。
// 不在 /app 嵌入式鉴权之下，改用 Bearer token（MANUAL_METRICS_EXPORT_TOKEN）保护。
//   GET /api/manual-metrics?from=YYYY-MM-DD[&to=YYYY-MM-DD][&shop=xxx.myshopify.com]
//   Header: Authorization: Bearer <token>
import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { rowToChannels } from "../models/manualMetrics.server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = process.env.MANUAL_METRICS_EXPORT_TOKEN;
  const auth = request.headers.get("authorization") || "";
  if (!token || auth !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to") || from;
  const shop = url.searchParams.get("shop");

  if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) {
    return Response.json(
      { error: "缺少或非法的 from / to（需 YYYY-MM-DD）" },
      { status: 400 },
    );
  }

  const rows = await prisma.manualDailyMetric.findMany({
    where: {
      businessDate: { gte: from, lte: to },
      ...(shop ? { shopDomain: shop } : {}),
    },
    orderBy: [{ businessDate: "desc" }, { locationName: "asc" }],
  });

  const records = rows.map((r) => ({
    business_date: r.businessDate,
    timezone: r.timezone,
    shop_domain: r.shopDomain,
    location_id: r.locationId,
    location_name: r.locationName,
    store_visit_groups: r.storeVisitGroups,
    channels: rowToChannels(r),
    traffic_factors: r.trafficFactors,
    notes: r.notes,
    submitted_by: r.submittedByName,
    submitted_at: r.submittedAt,
    updated_at: r.updatedAt,
  }));

  return Response.json({
    from,
    to,
    shop: shop ?? null,
    count: records.length,
    records,
  });
};
