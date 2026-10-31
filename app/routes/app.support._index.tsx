// 客服对话列表：默认只看"要店员回复"的，可切全部 / 已回复 / 已关闭；搜索客人邮箱 / 姓名 / 内容。
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { STATUS_LABEL, type ConversationStatus } from "../lib/supportRules";
import { requireModule } from "../models/modules.server";
import { countNeedsReply, getSupportConfig, listConversations, listKb, spentTodayCents, usageLastDays } from "../models/support.server";
import { assistantConfigured } from "../models/supportChat.server";
import { authenticate } from "../shopify.server";

const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "ai_support");
  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "needs";
  const q = url.searchParams.get("q") ?? "";
  const [rows, needs, cfg, kb, spent, days] = await Promise.all([
    listConversations(session.shop, { status: q ? "all" : view, q: q || null }),
    countNeedsReply(session.shop),
    getSupportConfig(session.shop),
    listKb(session.shop),
    spentTodayCents(session.shop),
    usageLastDays(session.shop, 7),
  ]);
  const week = days.reduce((a, d) => ({ req: a.req + d.requests, cents: a.cents + Math.round(d.costMicros / 10_000) }), { req: 0, cents: 0 });
  return {
    view,
    q,
    needs,
    configured: assistantConfigured(),
    storefrontToken: Boolean(process.env.STOREFRONT_PUBLIC_TOKEN),
    enabled: cfg.enabled,
    kbCount: kb.length,
    staffEmails: cfg.staffEmails.length,
    spentToday: (spent / 100).toFixed(2),
    budget: (cfg.dailyBudgetCents / 100).toFixed(2),
    week: { requests: week.req, dollars: (week.cents / 100).toFixed(2) },
    rows: rows.map((c) => ({
      id: c.id,
      status: c.status,
      statusLabel: STATUS_LABEL[c.status as ConversationStatus] ?? c.status,
      who: c.name || c.email || c.phone || (c.customerGid ? "Logged-in customer" : "Guest"),
      contact: [c.email, c.phone].filter(Boolean).join(" · "),
      locale: c.locale.toUpperCase(),
      last: c.messages[0]?.content.slice(0, 140) ?? "",
      lastRole: c.messages[0]?.role ?? "",
      summary: c.handoffSummary ?? "",
      reason: c.handoffReason ?? "",
      messages: c.messageCount,
      updated: fmt(c.updatedAt),
      flagged: c.flagged,
      page: c.productHandle ? `/products/${c.productHandle}` : c.pageUrl ? new URL(c.pageUrl).pathname : "",
    })),
  };
};

export default function SupportIndex() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };
  return (
    <s-page heading={`Support chat${d.needs ? ` · ${d.needs} waiting for staff` : ""}`}>
      <s-button slot="primary-action" href="/app/support/kb">
        Knowledge base ({d.kbCount})
      </s-button>
      <s-button slot="secondary-actions" href="/app/support/settings">
        Settings
      </s-button>

      {!d.configured && <s-banner tone="critical" heading="ANTHROPIC_API_KEY is not set on the server — the assistant answers with the offline message and only collects questions for staff." />}
      {!d.storefrontToken && <s-banner tone="warning" heading="STOREFRONT_PUBLIC_TOKEN is not set — product search and store stock tools will fail." />}
      {d.configured && !d.enabled && <s-banner tone="warning" heading="Assistant is switched off in Settings; the chat only takes messages for staff." />}
      {d.staffEmails === 0 && <s-banner tone="info" heading="No staff notification emails set — hand-offs only show here. Add emails in Settings to get a Klaviyo email per hand-off." />}
      {d.kbCount === 0 && <s-banner tone="warning" heading="Knowledge base is empty — open it and click “Restore defaults” before switching the chat on." />}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-select label="Show" value={d.view} onChange={(e: Event) => set("view", (e.target as HTMLSelectElement).value)}>
            <s-option value="needs">Needs staff reply ({d.needs})</s-option>
            <s-option value="open">Open (assistant handling)</s-option>
            <s-option value="answered">Replied by staff</s-option>
            <s-option value="closed">Closed</s-option>
            <s-option value="all">All</s-option>
          </s-select>
          <s-text-field
            label="Search name / email / phone / text"
            value={d.q}
            onChange={(e: Event) => set("q", (e.target as HTMLInputElement).value)}
          />
          <s-text color="subdued">
            Today ${d.spentToday} of ${d.budget} budget · last 7 days {d.week.requests} replies, ${d.week.dollars}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading={`${d.rows.length} conversation${d.rows.length === 1 ? "" : "s"}`}>
        {d.rows.length === 0 ? (
          <s-paragraph>Nothing here.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Last message</s-table-header>
              <s-table-header>Hand-off note</s-table-header>
              <s-table-header>Page</s-table-header>
              <s-table-header>Updated</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/support/${r.id}`}>{r.who}</s-link>
                    {r.contact && <s-text color="subdued"> {r.contact}</s-text>}
                    <s-text color="subdued"> · {r.locale}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.status === "handoff" ? "critical" : r.status === "answered" ? "success" : r.status === "closed" ? "neutral" : "info"}>{r.statusLabel}</s-badge>
                    {r.flagged && <s-badge tone="warning">flagged</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{r.lastRole === "user" ? "Customer: " : r.lastRole === "staff" ? "Staff: " : "AI: "}</s-text>
                    {r.last}
                  </s-table-cell>
                  <s-table-cell>{r.summary || (r.reason ? r.reason : "—")}</s-table-cell>
                  <s-table-cell>{r.page || "—"}</s-table-cell>
                  <s-table-cell>
                    {r.updated} <s-text color="subdued">({r.messages})</s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
