import { CHANNELS } from "../lib/channels";
import { listManualMetrics, rowToChannels } from "../models/manualMetrics.server";
import { sendReportNotifications, type NotificationResult } from "../lib/notifications.server";

const API_VERSION = "2025-04";
const PAID_STATUSES = new Set(["paid", "partially_paid", "partially_refunded", "refunded"]);

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function fmtMoney(value: number, currency = "CAD") {
  const prefix = currency === "CAD" ? "CA$" : `${currency} `;
  return `${prefix}${money(value).toLocaleString("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function locationNumericId(id: string | number | null | undefined): string {
  if (id === null || id === undefined) return "unknown";
  const s = String(id);
  const match = s.match(/(\d+)$/);
  return match ? match[1] : s;
}

function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function torontoOffsetForDate(dateString: string) {
  const noonUtc = new Date(`${dateString}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    timeZoneName: "shortOffset",
  }).formatToParts(noonUtc);
  const tz = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = tz.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return "-05:00";
  const [, sign, hour, minute = "00"] = match;
  return `${sign}${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function torontoDateRangeIso(businessDate: string) {
  const startOffset = torontoOffsetForDate(businessDate);
  const endDate = addDays(businessDate, 1);
  const endOffset = torontoOffsetForDate(endDate);
  return {
    start: `${businessDate}T00:00:00${startOffset}`,
    end: `${endDate}T00:00:00${endOffset}`,
  };
}

async function shopifyGet(shopDomain: string, accessToken: string, path: string, params?: Record<string, string | number>) {
  const query = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}` : "";
  const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}${path}${query}`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Shopify ${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

type ShopifyLocation = {
  id: number | string;
  name: string;
  active?: boolean;
};

type ShopifyOrder = {
  id: number | string;
  name?: string;
  processed_at?: string;
  total_price?: string;
  total_tax?: string;
  currency?: string;
  financial_status?: string;
  source_name?: string;
  location_id?: number | string | null;
  shipping_lines?: Array<{ price?: string }>;
  refunds?: Array<{ transactions?: Array<{ kind?: string; status?: string; amount?: string }> }>;
  line_items?: Array<{
    product_id?: number | string | null;
    title?: string;
    name?: string;
    quantity?: number;
    price?: string;
    discount_allocations?: Array<{ amount?: string }>;
  }>;
};

type SalesBucket = {
  locationId: string;
  locationName: string;
  paidOrders: number;
  allOrders: number;
  grossSales: number;
  tax: number;
  shipping: number;
  refunds: number;
  netSales: number;
};

type ManualBucket = {
  locationId: string;
  locationName: string;
  storeVisitGroups: number;
  channels: Record<string, number>;
  topChannel: string;
  unknown: number;
  trafficFactors: string[];
  notes: string | null;
};

function emptySalesBucket(locationId: string, locationName: string): SalesBucket {
  return {
    locationId,
    locationName,
    paidOrders: 0,
    allOrders: 0,
    grossSales: 0,
    tax: 0,
    shipping: 0,
    refunds: 0,
    netSales: 0,
  };
}

function shippingTotal(order: ShopifyOrder) {
  return (order.shipping_lines ?? []).reduce((sum, line) => sum + n(line.price), 0);
}

function refundTotal(order: ShopifyOrder) {
  let total = 0;
  for (const refund of order.refunds ?? []) {
    for (const transaction of refund.transactions ?? []) {
      if (transaction.kind === "refund" && transaction.status === "success") total += n(transaction.amount);
    }
  }
  return total;
}

function addOrder(bucket: SalesBucket, order: ShopifyOrder) {
  bucket.allOrders += 1;
  const status = order.financial_status ?? "";
  if (!PAID_STATUSES.has(status)) return;
  const gross = n(order.total_price);
  const tax = n(order.total_tax);
  const shipping = shippingTotal(order);
  const refunds = refundTotal(order);
  bucket.paidOrders += 1;
  bucket.grossSales += gross;
  bucket.tax += tax;
  bucket.shipping += shipping;
  bucket.refunds += refunds;
  bucket.netSales += gross - tax - shipping - refunds;
}

function topChannel(channels: Record<string, number>) {
  let bestLabel = "—";
  let bestValue = -1;
  for (const channel of CHANNELS) {
    const value = channels[channel.key] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      bestLabel = channel.label;
    }
  }
  return bestValue > 0 ? `${bestLabel} ${bestValue} 组` : "—";
}

function buildTopProducts(orders: ShopifyOrder[], limit = 8) {
  const byProduct = new Map<string, { idTail: string; title: string; quantity: number; grossSales: number }>();
  for (const order of orders) {
    if (!PAID_STATUSES.has(order.financial_status ?? "")) continue;
    for (const item of order.line_items ?? []) {
      const productId = String(item.product_id ?? "unknown");
      const existing = byProduct.get(productId) ?? {
        idTail: productId === "unknown" ? "unknown" : productId.slice(-6),
        title: item.title ?? item.name ?? "Unknown product",
        quantity: 0,
        grossSales: 0,
      };
      const quantity = n(item.quantity);
      existing.quantity += quantity;
      existing.grossSales += n(item.price) * quantity;
      byProduct.set(productId, existing);
    }
  }
  return [...byProduct.values()]
    .sort((a, b) => b.quantity - a.quantity || b.grossSales - a.grossSales)
    .slice(0, limit)
    .map((p) => ({ ...p, grossSales: money(p.grossSales) }));
}

export type LocationStoreReportStatus = {
  businessDate: string;
  locationId: string;
  locationName: string;
  markdown: string;
  payload: Record<string, unknown>;
  notificationResults: NotificationResult[];
};

export async function buildAndSendLocationStoreReport(params: {
  shopDomain: string;
  accessToken: string;
  businessDate: string;
  locationId: string;
  locationName?: string | null;
}): Promise<LocationStoreReportStatus> {
  const { shopDomain, accessToken, businessDate } = params;
  const requestedLocationId = locationNumericId(params.locationId);

  const locationsJson = await shopifyGet(shopDomain, accessToken, "/locations.json");
  const locations: ShopifyLocation[] = (locationsJson.locations ?? []).filter(
    (loc: ShopifyLocation) => loc.active !== false,
  );
  const location = locations.find((loc) => locationNumericId(loc.id) === requestedLocationId);
  const locationName = params.locationName ?? location?.name ?? requestedLocationId;

  const manualRows = await listManualMetrics({
    shopDomain,
    fromDate: businessDate,
    toDate: businessDate,
  });
  const manualRow = manualRows.find((row) => locationNumericId(row.locationId) === requestedLocationId);
  if (!manualRow) {
    throw new Error(`未找到 ${locationName} 在 ${businessDate} 的手动人流记录，无法生成单店报告。`);
  }

  const channels = rowToChannels(manualRow);
  const manual: ManualBucket = {
    locationId: requestedLocationId,
    locationName,
    storeVisitGroups: manualRow.storeVisitGroups,
    channels,
    topChannel: topChannel(channels),
    unknown: channels.unknown ?? 0,
    trafficFactors: (manualRow.trafficFactors as string[]) ?? [],
    notes: manualRow.notes,
  };

  const { start, end } = torontoDateRangeIso(businessDate);
  const ordersJson = await shopifyGet(shopDomain, accessToken, "/orders.json", {
    status: "any",
    limit: 250,
    processed_at_min: start,
    processed_at_max: end,
    fields: [
      "id",
      "name",
      "processed_at",
      "total_price",
      "total_tax",
      "currency",
      "financial_status",
      "source_name",
      "location_id",
      "shipping_lines",
      "refunds",
      "line_items",
    ].join(","),
  });

  const allOrders: ShopifyOrder[] = ordersJson.orders ?? [];
  const locationOrders = allOrders.filter(
    (order) => locationNumericId(order.location_id) === requestedLocationId,
  );
  const currency = locationOrders[0]?.currency ?? allOrders[0]?.currency ?? "CAD";

  const sales = emptySalesBucket(requestedLocationId, locationName);
  for (const order of locationOrders) addOrder(sales, order);

  const conversionRate = pct(sales.paidOrders, manual.storeVisitGroups);
  const topProducts = buildTopProducts(locationOrders);
  const knownChannels = CHANNELS.reduce((sum, channel) => sum + (manual.channels[channel.key] ?? 0), 0);
  const channelLines = CHANNELS
    .map((channel) => ({ label: channel.label, value: manual.channels[channel.key] ?? 0 }))
    .filter((channel) => channel.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((channel) => `- ${channel.label}：${channel.value} 组`);
  if (manual.unknown > 0) channelLines.push(`- 未知来源：${manual.unknown} 组`);

  const markdownLines = [
    `📊 Borderline 单店日报｜${locationName}｜${businessDate}`,
    ``,
    `**一句话结论**：${locationName} 今日到店 ${manual.storeVisitGroups} 组，产生 ${sales.paidOrders} 单，净销售额 ${fmtMoney(sales.netSales, currency)}，到店转化率 ${fmtPct(conversionRate)}。`,
    ``,
    `**核心数字**`,
    `- 净销售额：${fmtMoney(sales.netSales, currency)}`,
    `- 订单数：${sales.paidOrders} 单（该 location 总订单 ${sales.allOrders} 单）`,
    `- AOV：${fmtMoney(sales.paidOrders ? sales.netSales / sales.paidOrders : 0, currency)}`,
    `- 到店 group：${manual.storeVisitGroups} 组`,
    `- 到店转化率：${fmtPct(conversionRate)}`,
    `- 退款：${fmtMoney(sales.refunds, currency)}`,
    `- 运费：${fmtMoney(sales.shipping, currency)}（单独列示，不计主营收）`,
    ``,
    `**人流来源**`,
    ...(channelLines.length ? channelLines : ["暂无来源渠道数据"]),
    `- 已知来源合计：${knownChannels} 组；未知来源：${manual.unknown} 组`,
    `- 主来源：${manual.topChannel}`,
    ``,
    `**Top 产品**`,
    ...(topProducts.length
      ? topProducts.slice(0, 5).map((p, i) => `${i + 1}. ${p.title}：${p.quantity} 件，${fmtMoney(p.grossSales, currency)}`)
      : ["该门店今日暂无产品销售数据"]),
    ``,
    `**门店备注 / 影响因素**`,
    `- 影响因素：${manual.trafficFactors.length ? manual.trafficFactors.join("、") : "无"}`,
    `- 备注：${manual.notes || "无"}`,
    ``,
    `**需要注意**`,
    conversionRate === null
      ? `- 未填写到店 group 或到店为 0，无法判断转化率。`
      : conversionRate < 20
        ? `- 到店转化率低于 20%，建议复盘客源质量、店员跟进和热销品陈列。`
        : `- 到店转化率 ${fmtPct(conversionRate)}，优先保持当前高贡献来源渠道。`,
    manual.unknown > 0
      ? `- 仍有 ${manual.unknown} 组 unknown，建议店员继续追问来源，减少归因盲区。`
      : `- 今日所有到店 group 均已记录来源，无 unknown。`,
    ``,
    `**数据质量**：本报告只包含 ${locationName} 这个 Shopify location 的订单/销售/产品，以及该门店本次提交的人流表；不包含其他门店数据。`,
  ];

  const markdown = markdownLines.join("\n");
  const payload = {
    event_type: "store_location_report_ready",
    event: "store_location_report_ready",
    reportScope: "single_location",
    shopDomain,
    businessDate,
    location: {
      locationId: requestedLocationId,
      rawLocationId: params.locationId,
      locationName,
      netSales: money(sales.netSales),
      paidOrders: sales.paidOrders,
      allOrders: sales.allOrders,
      aov: money(sales.paidOrders ? sales.netSales / sales.paidOrders : 0),
      visitGroups: manual.storeVisitGroups,
      conversionRate,
      refunds: money(sales.refunds),
      shipping: money(sales.shipping),
      currency,
      channels: manual.channels,
      topChannel: manual.topChannel,
      unknownGroups: manual.unknown,
      knownChannelGroups: knownChannels,
      trafficFactors: manual.trafficFactors,
      notes: manual.notes,
    },
    totals: {
      netSales: money(sales.netSales),
      paidOrders: sales.paidOrders,
      allOrders: sales.allOrders,
      aov: money(sales.paidOrders ? sales.netSales / sales.paidOrders : 0),
      visitGroups: manual.storeVisitGroups,
      conversionRate,
      refunds: money(sales.refunds),
      shipping: money(sales.shipping),
      currency,
    },
    locations: [
      {
        locationName,
        netSales: money(sales.netSales),
        paidOrders: sales.paidOrders,
        allOrders: sales.allOrders,
        visitGroups: manual.storeVisitGroups,
        conversionRate,
        channels: manual.channels,
        notes: manual.notes,
      },
    ],
    topProducts,
    markdown,
  };

  const notificationResults = await sendReportNotifications({ markdown, payload });
  return {
    businessDate,
    locationId: requestedLocationId,
    locationName,
    markdown,
    payload,
    notificationResults,
  };
}
