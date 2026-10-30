// 首页：积分项目总览（KPI、上线检查单、webhook 健康、最近事件）+ 模块入口。
// 门店日报等其它模块只在 Modules 里开了才出现在导航和这里。
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { formatCents } from "../lib/redeemMath";
import { getModules } from "../models/modules.server";
import { loadOverview } from "../models/overview.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [overview, modules] = await Promise.all([loadOverview(session.shop), getModules(session.shop)]);
  return { overview, modules };
};

const n = (v: number) => v.toLocaleString("en-CA");

export default function Index() {
  const { overview: o, modules } = useLoaderData<typeof loader>();
  const enabledOther = modules.filter((m) => m.enabled && m.key !== "loyalty");
  const problems = o.checklist.filter((c) => !c.ok);

  return (
    <s-page heading="Borderline Points">
      <s-button slot="primary-action" variant="primary" href="/app/loyalty">
        Members
      </s-button>
      <s-button slot="secondary-actions" href="/app/loyalty/settings">
        Rules
      </s-button>
      <s-button slot="secondary-actions" href="/app/modules">
        Modules
      </s-button>

      {problems.length > 0 && (
        <s-banner tone="warning" heading={`${problems.length} setup item${problems.length > 1 ? "s" : ""} need attention`}>
          <s-unordered-list>
            {problems.map((c) => (
              <s-list-item key={c.key}>
                <s-text>
                  {c.label}: {c.detail}
                </s-text>
                {c.href && (
                  <>
                    {" "}
                    <s-link href={c.href}>Open</s-link>
                  </>
                )}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
      {o.webhooks.failed24h > 0 && (
        <s-banner tone="critical" heading={`${o.webhooks.failed24h} webhook event(s) failed in the last 24 hours`}>
          <s-paragraph>See the recent events list below; failed events are retried by the queue and the 10-minute sweep.</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Last 30 days">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Kpi label="Members" value={n(o.members.total)} sub={`${n(o.members.paid)} paid · ${n(o.members.newLast30d)} new`} />
          <Kpi label="Points outstanding" value={n(o.points.outstanding)} sub={`${n(o.members.withBalance)} members hold points`} />
          <Kpi label="Points issued" value={n(o.points.issued30d)} sub="earned + bonuses + adjustments" />
          <Kpi label="Points redeemed" value={n(o.points.redeemed30d)} sub={`${formatCents(o.redemptions30d.amountCents)} of value`} />
          <Kpi
            label="Redemptions"
            value={n(o.redemptions30d.storeCredit + o.redemptions30d.cartDiscount + o.redemptions30d.discountCode)}
            sub={`${o.redemptions30d.storeCredit} store credit · ${o.redemptions30d.cartDiscount} cart · ${o.redemptions30d.discountCode} codes`}
          />
          <Kpi
            label="Webhooks (24h)"
            value={n(o.webhooks.last24h)}
            sub={o.webhooks.lastReceivedAt ? `last ${o.webhooks.lastTopic} ${o.webhooks.lastReceivedAt.replace("T", " ").slice(5, 16)} UTC` : "none yet"}
          />
        </s-grid>
      </s-section>

      <s-section heading="Setup checklist">
        <s-stack direction="block" gap="small-200">
          {o.checklist.map((c) => (
            <s-stack key={c.key} direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={c.ok ? "success" : "warning"}>{c.ok ? "OK" : "To do"}</s-badge>
              <s-text>
                <strong>{c.label}</strong> · {c.detail}
              </s-text>
              {c.href && <s-link href={c.href}>Open</s-link>}
            </s-stack>
          ))}
          <s-text color="subdued">
            POS tile and customer-account page are installed with the app version; the storefront blocks are added in the theme editor
            (Points badge on the product page, Points banner in the cart).
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Recent webhook events">
        {o.recentEvents.length === 0 ? (
          <s-paragraph>No events yet. The first paid order will show up here within seconds.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Received (UTC)</s-table-header>
              <s-table-header>Topic</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Note</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {o.recentEvents.map((e, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{e.at}</s-table-cell>
                  <s-table-cell>{e.topic}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={e.status === "done" ? "success" : e.status === "failed" ? "critical" : "neutral"}>{e.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{e.note ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {enabledOther.length > 0 && (
        <s-section heading="Other modules">
          <s-stack direction="block" gap="small-200">
            {enabledOther.map((m) => (
              <s-stack key={m.key} direction="inline" gap="small-200" alignItems="center">
                <s-link href={m.entry ?? "/app/modules"}>{m.name}</s-link>
                <s-text color="subdued">{m.description}</s-text>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-100">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{sub}</s-text>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
