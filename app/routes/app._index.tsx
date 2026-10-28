import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { torontoToday, torontoYesterday } from "../lib/dates";
import { listManualMetrics } from "../models/manualMetrics.server";

type LocationOption = { id: string; name: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const locResp = await admin.graphql(
    `#graphql
    query HomeLocations { locations(first: 50) { edges { node { id name } } } }`,
  );
  const locJson = await locResp.json();
  const locations: LocationOption[] = (locJson.data?.locations?.edges ?? []).map(
    (e: { node: LocationOption }) => ({ id: e.node.id, name: e.node.name }),
  );

  const yesterday = torontoYesterday();
  const today = torontoToday();
  const rows = await listManualMetrics({
    shopDomain: session.shop,
    fromDate: yesterday,
    toDate: today,
  });
  const submitted = new Set(rows.map((r) => `${r.businessDate}__${r.locationId}`));

  const statuses = locations.map((l) => ({
    id: l.id,
    name: l.name,
    yesterday: submitted.has(`${yesterday}__${l.id}`),
    today: submitted.has(`${today}__${l.id}`),
  }));
  const missingYesterday = statuses.filter((s) => !s.yesterday).map((s) => s.name);

  return { yesterday, today, statuses, missingYesterday };
};

export default function Index() {
  const { yesterday, today, statuses, missingYesterday } = useLoaderData<typeof loader>();

  return (
    <s-page heading="BorderlineAI 每日数据录入">
      <s-button slot="primary-action" variant="primary" href={`/app/manual-entry?date=${yesterday}`}>
        填写昨日数据
      </s-button>

      {missingYesterday.length > 0 && (
        <s-banner tone="warning" heading="昨日还有门店未录入">
          <s-paragraph>未录入：{missingYesterday.join("、")}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="录入状态">
        <s-paragraph>
          这些数据不会修改 Shopify 订单或广告投放，只用于每日经营分析和广告归因。
        </s-paragraph>
        <s-stack direction="block" gap="base">
          {statuses.length === 0 && (
            <s-text>未找到门店，请先在 Settings → Locations 添加门店。</s-text>
          )}
          {statuses.map((s) => (
            <s-box
              key={s.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="inline" gap="base" justifyContent="space-between">
                <s-text>{s.name}</s-text>
                <s-text>
                  昨日 {s.yesterday ? "✅ 已填" : "⛔ 未填"}{"　"}今日{" "}
                  {s.today ? "✅ 已填" : "—"}
                </s-text>
                <s-button href={`/app/manual-entry?date=${yesterday}&location=${s.id}`}>
                  填昨日
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="快捷入口">
        <s-stack direction="block" gap="base">
          <s-button href={`/app/manual-entry?date=${today}`}>填写今日数据</s-button>
          <s-button href="/app/manual-history" variant="secondary">
            查看历史记录
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
