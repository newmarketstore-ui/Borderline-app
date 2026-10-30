import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireModule } from "../models/modules.server";
import { authenticate } from "../shopify.server";
import { torontoToday } from "../lib/dates";
import { listManualMetrics, rowToChannels } from "../models/manualMetrics.server";
import { CHANNELS } from "../lib/channels";


function topChannel(channels: Record<string, number>): string {
  let best = "";
  let bestVal = -1;
  for (const c of CHANNELS) {
    if ((channels[c.key] ?? 0) > bestVal) {
      bestVal = channels[c.key] ?? 0;
      best = c.label;
    }
  }
  return bestVal > 0 ? `${best}（${bestVal}）` : "—";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "store_metrics");

  const url = new URL(request.url);
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
  const today = torontoToday();
  const from = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

  const rows = await listManualMetrics({
    shopDomain: session.shop,
    fromDate: from,
    toDate: today,
  });

  const records = rows.map((r) => {
    const channels = rowToChannels(r);
    const knownTotal = CHANNELS.reduce((s, c) => s + (channels[c.key] ?? 0), 0);
    return {
      id: r.id,
      businessDate: r.businessDate,
      locationId: r.locationId,
      locationName: r.locationName ?? r.locationId,
      storeVisitGroups: r.storeVisitGroups,
      knownTotal,
      unknown: channels.unknown ?? 0,
      topChannel: topChannel(channels),
      submittedBy: r.submittedByName ?? "—",
      updatedAt: r.updatedAt,
    };
  });

  return { days, from, today, records };
};

export default function ManualHistory() {
  const { days, from, today, records } = useLoaderData<typeof loader>();

  return (
    <s-page heading="历史录入记录">
      <s-button slot="primary-action" href="/app/manual-entry" variant="primary">
        去录入
      </s-button>

      <s-section heading={`最近 ${days} 天（${from} ~ ${today}）`}>
        <s-stack direction="block" gap="base">
          {records.length === 0 && <s-text>这段时间还没有任何录入记录。</s-text>}
          {records.map((r) => (
            <s-box
              key={r.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="base" justifyContent="space-between">
                  <s-text>
                    {r.businessDate}{"　"}{r.locationName}
                  </s-text>
                  <s-button
                    href={`/app/manual-entry?date=${r.businessDate}&location=${r.locationId}`}
                    variant="secondary"
                  >
                    编辑
                  </s-button>
                </s-stack>
                <s-text>
                  到店 {r.storeVisitGroups} 组｜主渠道 {r.topChannel}｜未知 {r.unknown}｜记录人 {r.submittedBy}
                </s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
