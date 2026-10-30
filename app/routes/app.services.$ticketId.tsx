// 工单详情：客人信息、装板参数、状态按钮、延期 + 抱歉通知、备注、重发通知、通知记录、历史。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";

import { NEXT_STATUSES, STATUS_LABEL, type TicketStatus } from "../lib/serviceRules";
import { staffIdentity } from "../models/loyalty.server";
import { requireModule } from "../models/modules.server";
import { delayTicket, getStore, getTicket, notify, queueAhead, setStatus, statusUrl, updateTicketFields } from "../models/services.server";
import { authenticate } from "../shopify.server";

const fmt = (d: Date | string | null | undefined, tz: string, withTime = true) =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "short", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).format(new Date(d)) : "—";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "service_tickets");
  const t = await getTicket(session.shop, String(params.ticketId));
  if (!t) throw new Response("Ticket not found", { status: 404 });
  const store = await getStore(session.shop, t.storeKey);
  const tz = store?.timezone ?? "America/Toronto";
  const ahead = ["received", "in_progress", "on_hold"].includes(t.status) ? await queueAhead(session.shop, t.storeKey, t.createdAt) : 0;
  return {
    tz,
    storeName: store?.name ?? t.storeKey,
    ahead,
    statusUrl: statusUrl(t.token),
    t: {
      id: t.id,
      tag: t.tagNumber,
      status: t.status,
      next: NEXT_STATUSES[t.status as TicketStatus] ?? [],
      name: t.customerName,
      email: t.email,
      phone: t.phone,
      customerGid: t.shopifyCustomerId,
      memberId: t.memberId,
      services: (t.services as Array<{ name: string; durationMin?: number }>),
      equipment: t.equipment,
      boardInfo: t.boardInfo,
      edgeAngle: t.edgeAngle,
      heightCm: t.heightCm,
      weightKg: t.weightKg,
      din: t.din,
      stance: [t.stanceFront, t.stanceBack, t.stanceWidth].filter(Boolean).join(" / "),
      customerNotes: t.customerNotes,
      staffNotes: t.staffNotes ?? "",
      source: t.source,
      consent: `${t.consentSms ? "SMS" : ""}${t.consentSms && t.consentEmail ? " + " : ""}${t.consentEmail ? "email" : ""}` || "none",
      paid: t.paid,
      order: t.orderName,
      created: fmt(t.createdAt, tz),
      etaDate: t.etaAt ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t.etaAt) : "",
      eta: fmt(t.etaAt, tz, false),
      etaNote: t.etaNote,
      delayCount: t.delayCount,
      readyAt: fmt(t.readyAt, tz),
      pickedUpAt: fmt(t.pickedUpAt, tz),
      history: ((t.history as Array<{ at: string; status: string; by: string; note?: string | null }>) ?? []).slice().reverse().map((h) => ({ ...h, at: fmt(h.at, tz) })),
      notifications: t.notifications.map((n) => ({ id: n.id, at: fmt(n.createdAt, tz), kind: n.kind, channel: n.channel, ok: n.ok, error: n.error, to: [n.toPhone, n.toEmail].filter(Boolean).join(" · ") })),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const by = staffIdentity(session, sessionToken);
  const id = String(params.ticketId);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "status") {
      await setStatus(session.shop, id, String(form.get("status")) as TicketStatus, by, String(form.get("note") ?? "") || null);
    } else if (intent === "delay") {
      const date = String(form.get("date") ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Pick a date" };
      await delayTicket(session.shop, id, date, by, String(form.get("message") ?? "") || null);
    } else if (intent === "notes") {
      await updateTicketFields(session.shop, id, { staffNotes: String(form.get("staffNotes") ?? "") || null }, by);
    } else if (intent === "contact") {
      await updateTicketFields(
        session.shop,
        id,
        { customerName: String(form.get("name") ?? "").trim() || undefined, email: String(form.get("email") ?? "").trim().toLowerCase() || null, phone: String(form.get("phone") ?? "").replace(/\D/g, "") || null },
        by,
      );
    } else if (intent === "resend") {
      const t = await getTicket(session.shop, id);
      if (!t) return { ok: false, error: "Ticket not found" };
      const kind = t.status === "ready" ? "ready" : "received";
      const res = await notify(t, kind, by);
      if (!res.ok) return { ok: false, error: res.error ?? "not sent" };
    } else {
      return { ok: false, error: "Unknown action" };
    }
    return { ok: true, intent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export default function TicketPage() {
  const { t, tz, storeName, ahead, statusUrl: link } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [delayDate, setDelayDate] = useState(t.etaDate);
  const [delayMsg, setDelayMsg] = useState("");
  const [notes, setNotes] = useState(t.staffNotes);
  const [name, setName] = useState(t.name);
  const [email, setEmail] = useState(t.email ?? "");
  const [phone, setPhone] = useState(t.phone ?? "");
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "delay") setDelayMsg("");
  }, [fetcher.data]);
  const submit = (fields: Record<string, string>) => fetcher.submit(fields, { method: "POST" });
  const labelFor = (n: string) => (n === "in_progress" ? "Start work" : n === "ready" ? "Done → notify customer" : n === "picked_up" ? "Picked up" : n === "received" ? "Back to not started" : STATUS_LABEL[n as TicketStatus]);

  return (
    <s-page heading={`Tag #${t.tag} · ${t.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/services">
        Services
      </s-link>
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}
      {fetcher.data?.ok && <s-banner tone="success" heading="Saved" />}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={t.status === "ready" ? "success" : t.status === "in_progress" ? "info" : t.status === "on_hold" ? "warning" : "neutral"}>{STATUS_LABEL[t.status as TicketStatus] ?? t.status}</s-badge>
            <s-text>
              {storeName} · dropped off {t.created} · {ahead > 0 ? `${ahead} ahead in queue` : "front of queue"}
              {t.paid ? ` · paid${t.order ? ` (${t.order})` : ""}` : " · not matched to an order yet"}
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="small-200">
            {t.next.map((n) => (
              <s-button key={n} variant={n === "ready" || n === "picked_up" ? "primary" : n === "cancelled" ? "tertiary" : "secondary"} tone={n === "cancelled" ? "critical" : undefined} onClick={() => submit({ intent: "status", status: n })} {...(busy ? { disabled: true } : {})}>
                {labelFor(n)}
              </s-button>
            ))}
          </s-stack>
          <s-text color="subdued">
            Estimated pickup <strong>{t.eta}</strong>
            {t.etaNote ? ` · ${t.etaNote}` : ""}
            {t.delayCount ? ` · delayed ${t.delayCount}x` : ""} · ready {t.readyAt} · picked up {t.pickedUpAt}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Running late? Move the pickup date and apologise">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field label="New pickup date (YYYY-MM-DD)" value={delayDate} onInput={(e: Event) => setDelayDate((e.target as HTMLInputElement).value)} />
          <s-text-field label="Message to customer (optional)" value={delayMsg} onInput={(e: Event) => setDelayMsg((e.target as HTMLInputElement).value)} placeholder="Sorry, the grinder is backed up; ready after 2 pm" />
          <s-button variant="primary" onClick={() => submit({ intent: "delay", date: delayDate, message: delayMsg })} {...(busy ? { disabled: true } : {})}>
            Send apology + new date
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Work details">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <strong>Services:</strong> {t.services.map((s) => s.name).join(", ")} ({t.services.reduce((a, s) => a + (s.durationMin ?? 0), 0)} min est.)
          </s-text>
          <s-text>
            <strong>Equipment:</strong> {t.equipment ?? "—"} {t.boardInfo ? `· ${t.boardInfo}` : ""}
          </s-text>
          {t.edgeAngle && (
            <s-text>
              <strong>Edge angle request:</strong> {t.edgeAngle}
            </s-text>
          )}
          {(t.heightCm || t.weightKg || t.din) && (
            <s-text>
              <strong>Binding (ski):</strong> {t.heightCm ?? "?"} cm · {t.weightKg ?? "?"} kg · DIN {t.din ?? "recommended"}
            </s-text>
          )}
          {t.stance && (
            <s-text>
              <strong>Snowboard stance:</strong> {t.stance}
            </s-text>
          )}
          {t.customerNotes && (
            <s-text>
              <strong>Customer notes:</strong> {t.customerNotes}
            </s-text>
          )}
          <s-text-area label="Tech notes (internal)" rows={3} value={notes} onInput={(e: Event) => setNotes((e.target as HTMLTextAreaElement).value)} />
          <s-button onClick={() => submit({ intent: "notes", staffNotes: notes })} {...(busy ? { disabled: true } : {})}>
            Save notes
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Customer">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field label="Name" value={name} onInput={(e: Event) => setName((e.target as HTMLInputElement).value)} />
            <s-text-field label="Phone" value={phone} onInput={(e: Event) => setPhone((e.target as HTMLInputElement).value)} />
            <s-text-field label="Email" value={email} onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)} />
            <s-button onClick={() => submit({ intent: "contact", name, phone, email })} {...(busy ? { disabled: true } : {})}>
              Save contact
            </s-button>
          </s-stack>
          <s-text color="subdued">
            Notifications: {t.consent} · source {t.source}
            {t.memberId ? (
              <>
                {" "}
                · <s-link href={`/app/loyalty/${t.memberId}`}>member profile</s-link>
              </>
            ) : (
              " · not linked to a member"
            )}
          </s-text>
          <s-text color="subdued">
            Customer status link: <s-link href={link} target="_blank">{link}</s-link>
          </s-text>
          <s-button onClick={() => submit({ intent: "resend" })} {...(busy ? { disabled: true } : {})}>
            Resend {t.status === "ready" ? "ready" : "confirmation"} notification
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Notifications sent">
        {t.notifications.length === 0 ? (
          <s-paragraph>None yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">When</s-table-header>
              <s-table-header>Kind</s-table-header>
              <s-table-header>To</s-table-header>
              <s-table-header>Result</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {t.notifications.map((n) => (
                <s-table-row key={n.id}>
                  <s-table-cell>{n.at}</s-table-cell>
                  <s-table-cell>{n.kind}</s-table-cell>
                  <s-table-cell>{n.to || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={n.ok ? "success" : n.channel === "log" ? "neutral" : "critical"}>{n.ok ? "sent" : n.channel === "log" ? "logged (Klaviyo not connected)" : "failed"}</s-badge>
                    {n.error && !n.ok && n.channel !== "log" ? ` ${n.error}` : ""}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="History">
        <s-stack direction="block" gap="small-100">
          {t.history.map((h, i) => (
            <s-text key={i}>
              {h.at} · {STATUS_LABEL[h.status as TicketStatus] ?? h.status} · {h.by}
              {h.note ? ` · ${h.note}` : ""}
            </s-text>
          ))}
        </s-stack>
      </s-section>
      <s-text color="subdued">Times in {tz}.</s-text>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
