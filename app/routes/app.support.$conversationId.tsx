// 单个对话：全文、工具调用、店员回复（邮件 / 短信 / 只记录）、关闭 / 重开、标记答错（每周回灌知识库用）。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { replyChannels, STATUS_LABEL, type ConversationStatus } from "../lib/supportRules";
import { staffIdentity } from "../models/loyalty.server";
import { requireModule } from "../models/modules.server";
import { flagConversation, getConversation, setConversationStatus, setContact, staffReply } from "../models/support.server";
import { authenticate } from "../shopify.server";

const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(d));

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "ai_support");
  const c = await getConversation(session.shop, params.conversationId!);
  if (!c) throw new Response("Not found", { status: 404 });
  const smsEnabled = process.env.SUPPORT_SMS_ENABLED === "1";
  return {
    c: {
      id: c.id,
      status: c.status,
      statusLabel: STATUS_LABEL[c.status as ConversationStatus] ?? c.status,
      name: c.name ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      customerGid: c.customerGid,
      customerAdminUrl: c.customerGid ? `shopify://admin/customers/${c.customerGid.split("/").pop()}` : null,
      locale: c.locale,
      pageUrl: c.pageUrl,
      productHandle: c.productHandle,
      handoffReason: c.handoffReason,
      handoffSummary: c.handoffSummary,
      handoffAt: c.handoffAt ? fmt(c.handoffAt) : null,
      flagged: c.flagged,
      flagNote: c.flagNote ?? "",
      assignedTo: c.assignedTo,
      cost: (c.costMicros / 1_000_000).toFixed(3),
      tokens: `${c.inputTokens.toLocaleString()} in / ${c.outputTokens.toLocaleString()} out`,
      created: fmt(c.createdAt),
      channels: replyChannels(c, smsEnabled),
    },
    messages: c.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      at: fmt(m.createdAt),
      via: m.deliveredVia,
      by: m.createdBy,
      latency: m.latencyMs,
      tools: ((m.meta as { tools?: Array<{ name: string; input: Record<string, unknown>; ok: boolean; ms: number; summary?: string }> } | null)?.tools ?? []).map((t) => ({
        name: t.name,
        input: JSON.stringify(t.input),
        ok: t.ok,
        ms: t.ms,
        summary: t.summary ?? "",
      })),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const by = staffIdentity(session, sessionToken);
  const id = params.conversationId!;
  try {
    if (intent === "reply") {
      const via = String(form.get("via") ?? "email") as "email" | "sms" | "none";
      const r = await staffReply(session.shop, id, String(form.get("text") ?? ""), by, via);
      if (via !== "none" && !r.delivery.ok) return { ok: true, warning: `Saved, but not delivered: ${r.delivery.error ?? "unknown"}` };
      return { ok: true, message: via === "none" ? "Saved (not sent)" : `Sent by ${via} via Klaviyo` };
    }
    if (intent === "status") {
      await setConversationStatus(session.shop, id, String(form.get("status")) as ConversationStatus);
      return { ok: true, message: "Status updated" };
    }
    if (intent === "flag") {
      await flagConversation(session.shop, id, form.get("flagged") === "1", String(form.get("note") ?? "").trim().slice(0, 500) || null);
      return { ok: true, message: "Flag saved" };
    }
    if (intent === "contact") {
      await setContact(session.shop, id, { name: String(form.get("name") ?? ""), email: String(form.get("email") ?? ""), phone: String(form.get("phone") ?? "") });
      return { ok: true, message: "Contact saved" };
    }
    return { ok: false, error: "Unknown action" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export default function SupportConversationPage() {
  const { c, messages } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const roleLabel: Record<string, string> = { user: "Customer", assistant: "Assistant", staff: "Staff", system: "System" };
  return (
    <s-page heading={`${c.name || c.email || c.phone || "Guest"} · ${c.statusLabel}`}>
      <s-link slot="breadcrumb-actions" href="/app/support">
        Support chat
      </s-link>
      {fetcher.data?.ok && (fetcher.data.message || fetcher.data.warning) && <s-banner tone={fetcher.data.warning ? "warning" : "success"} heading={fetcher.data.warning ?? fetcher.data.message} />}
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}

      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="Conversation">
            <s-stack direction="block" gap="base">
              {messages.map((m) => (
                <s-box key={m.id} padding="small-200" borderWidth="small" borderRadius="base" background={m.role === "user" ? "subdued" : m.role === "staff" ? "strong" : "base"}>
                  <s-stack direction="block" gap="small-100">
                    <s-text color="subdued">
                      {roleLabel[m.role] ?? m.role} · {m.at}
                      {m.by ? ` · ${m.by}` : ""}
                      {m.via ? ` · ${m.via}` : ""}
                      {m.latency ? ` · ${(m.latency / 1000).toFixed(1)}s` : ""}
                    </s-text>
                    <s-paragraph>{m.content}</s-paragraph>
                    {m.tools.length > 0 && (
                      <s-text color="subdued">
                        {m.tools.map((t, i) => (
                          <span key={i}>
                            {t.ok ? "✓" : "✗"} {t.name} {t.input} ({t.ms} ms) — {t.summary}
                            <br />
                          </span>
                        ))}
                      </s-text>
                    )}
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          </s-section>

          <s-section heading="Reply as staff">
            {c.channels.length === 0 && <s-banner tone="warning" heading="No email or phone on this conversation — add contact details on the right, or the reply is only stored." />}
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="reply" />
              <s-stack direction="block" gap="base">
                <s-text-area name="text" label="Message to the customer" rows={5} placeholder={c.locale === "fr" ? "Répondez en français…" : "Write the reply…"} />
                <s-select name="via" label="Send by" value={c.channels[0] ?? "none"}>
                  {c.channels.includes("email") && <s-option value="email">Email ({c.email})</s-option>}
                  {c.channels.includes("sms") && <s-option value="sms">SMS ({c.phone})</s-option>}
                  <s-option value="none">Don’t send — just record</s-option>
                </s-select>
                <s-button type="submit" variant="primary" disabled={busy}>
                  Send reply
                </s-button>
              </s-stack>
            </fetcher.Form>
          </s-section>
        </s-stack>

        <s-stack direction="block" gap="base">
          <s-section heading="Customer">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="contact" />
              <s-stack direction="block" gap="small-200">
                <s-text-field name="name" label="Name" defaultValue={c.name} />
                <s-text-field name="email" label="Email" defaultValue={c.email} />
                <s-text-field name="phone" label="Phone" defaultValue={c.phone} />
                {c.customerAdminUrl && (
                  <s-link href={c.customerAdminUrl} target="_blank">
                    Open customer in Shopify
                  </s-link>
                )}
                <s-button type="submit" disabled={busy}>
                  Save contact
                </s-button>
              </s-stack>
            </fetcher.Form>
          </s-section>

          <s-section heading="Details">
            <s-stack direction="block" gap="small-100">
              <s-text>Language: {c.locale.toUpperCase()}</s-text>
              <s-text>Started: {c.created}</s-text>
              {c.productHandle && (
                <s-link href={`https://borderlinestore.ca/products/${c.productHandle}`} target="_blank">
                  Product: {c.productHandle}
                </s-link>
              )}
              {c.pageUrl && !c.productHandle && <s-text>Page: {c.pageUrl}</s-text>}
              {c.handoffAt && (
                <s-text>
                  Hand-off {c.handoffAt} · {c.handoffReason}
                  {c.handoffSummary ? ` — ${c.handoffSummary}` : ""}
                </s-text>
              )}
              {c.assignedTo && <s-text>Last staff: {c.assignedTo}</s-text>}
              <s-text color="subdued">
                Cost ${c.cost} · {c.tokens}
              </s-text>
            </s-stack>
          </s-section>

          <s-section heading="Status">
            <s-stack direction="inline" gap="small-200">
              {c.status !== "closed" && (
                <s-button disabled={busy} onClick={() => fetcher.submit({ intent: "status", status: "closed" }, { method: "POST" })}>
                  Close
                </s-button>
              )}
              {c.status !== "handoff" && (
                <s-button disabled={busy} onClick={() => fetcher.submit({ intent: "status", status: "handoff" }, { method: "POST" })}>
                  Mark needs reply
                </s-button>
              )}
              {c.status === "closed" && (
                <s-button disabled={busy} onClick={() => fetcher.submit({ intent: "status", status: "open" }, { method: "POST" })}>
                  Reopen
                </s-button>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Quality">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="flag" />
              <input type="hidden" name="flagged" value={c.flagged ? "0" : "1"} />
              <s-stack direction="block" gap="small-200">
                <s-text-area name="note" label="What was wrong / missing (feeds the weekly knowledge-base update)" defaultValue={c.flagNote} rows={3} />
                <s-button type="submit" disabled={busy} tone={c.flagged ? "neutral" : "critical"}>
                  {c.flagged ? "Clear flag" : "Flag wrong answer"}
                </s-button>
              </s-stack>
            </fetcher.Form>
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
