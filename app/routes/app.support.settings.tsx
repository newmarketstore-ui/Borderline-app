// 客服设置：开关、预算、限速、店员通知邮箱、问候语、老板临时规矩。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { isEmail } from "../lib/supportRules";
import { staffIdentity } from "../models/loyalty.server";
import { requireModule } from "../models/modules.server";
import { getSupportConfig, saveSupportConfig, usageLastDays } from "../models/support.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "ai_support");
  const [cfg, days] = await Promise.all([getSupportConfig(session.shop), usageLastDays(session.shop, 14)]);
  return {
    cfg: { ...cfg, updatedAt: cfg.updatedAt.toISOString(), createdAt: cfg.createdAt.toISOString(), staffEmailsText: cfg.staffEmails.join("\n") },
    days: days.map((d) => ({ day: d.day, requests: d.requests, dollars: (d.costMicros / 1_000_000).toFixed(2), inTok: d.inputTokens, outTok: d.outputTokens })),
    klaviyo: Boolean(process.env.KLAVIYO_PRIVATE_KEY),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const num = (k: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(form.get(k) ?? 0) || 0)));
  const emails = String(form.get("staffEmails") ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = emails.filter((e) => !isEmail(e));
  if (bad.length) return { ok: false, error: `Not an email: ${bad.join(", ")}` };
  const model = String(form.get("model") ?? "claude-sonnet-5-5").trim();
  if (!/^claude-sonnet-/.test(model)) return { ok: false, error: "Only Sonnet models are allowed (owner rule 2026-10-31)." };
  try {
    await saveSupportConfig(
      session.shop,
      {
        enabled: form.get("enabled") === "on",
        model,
        dailyBudgetCents: num("dailyBudgetDollars", 1, 500) * 100,
        perVisitorHourly: num("perVisitorHourly", 5, 500),
        perIpHourly: num("perIpHourly", 5, 2000),
        maxTurns: num("maxTurns", 5, 200),
        staffEmails: emails,
        greetingEn: String(form.get("greetingEn") ?? "").trim().slice(0, 300) || undefined,
        greetingFr: String(form.get("greetingFr") ?? "").trim().slice(0, 300) || undefined,
        extraPrompt: String(form.get("extraPrompt") ?? "").trim().slice(0, 4000) || null,
      },
      staffIdentity(session, sessionToken),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export default function SupportSettings() {
  const { cfg, days, klaviyo } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <s-page heading="Support chat · Settings">
      <s-link slot="breadcrumb-actions" href="/app/support">
        Support chat
      </s-link>
      {fetcher.data?.ok && <s-banner tone="success" heading="Saved" />}
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}
      {!klaviyo && <s-banner tone="warning" heading="KLAVIYO_PRIVATE_KEY is not set — hand-off and reply emails are only logged." />}

      <fetcher.Form method="post">
        <s-section heading="Assistant">
          <s-stack direction="block" gap="base">
            <s-checkbox name="enabled" label="Assistant on (off = chat only collects messages for staff)" defaultChecked={cfg.enabled} />
            <s-text-field name="model" label="Model" defaultValue={cfg.model} details="Sonnet only. Current: claude-sonnet-5-5." />
            <s-stack direction="inline" gap="base">
              <s-number-field name="dailyBudgetDollars" label="Daily budget (USD)" defaultValue={String(cfg.dailyBudgetCents / 100)} min={1} max={500} details="When reached, the chat switches to the offline message until midnight Toronto." />
              <s-number-field name="perVisitorHourly" label="Messages per visitor / hour" defaultValue={String(cfg.perVisitorHourly)} min={5} max={500} />
              <s-number-field name="perIpHourly" label="Messages per IP / hour" defaultValue={String(cfg.perIpHourly)} min={5} max={2000} />
              <s-number-field name="maxTurns" label="Max messages per conversation" defaultValue={String(cfg.maxTurns)} min={5} max={200} />
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Staff notifications">
          <s-text-area name="staffEmails" label="Email each hand-off to (one per line)" defaultValue={cfg.staffEmailsText} rows={3} details="Sent as the Klaviyo event “Support Handoff”; the Flow emails these addresses with the question and a link back here." />
        </s-section>

        <s-section heading="Greeting shown when the chat opens">
          <s-stack direction="block" gap="base">
            <s-text-field name="greetingEn" label="English" defaultValue={cfg.greetingEn} />
            <s-text-field name="greetingFr" label="French" defaultValue={cfg.greetingFr} />
          </s-stack>
        </s-section>

        <s-section heading="Extra rules for the assistant (optional)">
          <s-text-area
            name="extraPrompt"
            label="Appended to the system prompt — plain sentences, e.g. “Boxing Day hours: all stores 10–6.”"
            defaultValue={cfg.extraPrompt ?? ""}
            rows={5}
          />
        </s-section>

        <s-section>
          <s-button type="submit" variant="primary" disabled={busy}>
            Save
          </s-button>
        </s-section>
      </fetcher.Form>

      <s-section heading="Usage (last 14 days)">
        {days.length === 0 ? (
          <s-paragraph>No usage yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Day</s-table-header>
              <s-table-header>Replies</s-table-header>
              <s-table-header>Input tokens</s-table-header>
              <s-table-header>Output tokens</s-table-header>
              <s-table-header>Cost (USD)</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {days.map((d) => (
                <s-table-row key={d.day}>
                  <s-table-cell>{d.day}</s-table-cell>
                  <s-table-cell>{d.requests}</s-table-cell>
                  <s-table-cell>{d.inTok.toLocaleString()}</s-table-cell>
                  <s-table-cell>{d.outTok.toLocaleString()}</s-table-cell>
                  <s-table-cell>${d.dollars}</s-table-cell>
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
