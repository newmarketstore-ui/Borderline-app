// 服务工单看板：按店切换（默认 RH），按状态分组，一键改状态，搜索 tag / 姓名 / 电话。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { NEXT_STATUSES, STATUS_LABEL, type TicketStatus } from "../lib/serviceRules";
import { staffIdentity } from "../models/loyalty.server";
import { requireModule } from "../models/modules.server";
import { etaForStore, getStores, listTickets, setStatus } from "../models/services.server";
import { authenticate } from "../shopify.server";

const fmt = (d: Date | string | null, tz: string, withTime = true) =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "short", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).format(new Date(d)) : "—";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "service_tickets");
  const url = new URL(request.url);
  const stores = await getStores(session.shop);
  const storeKey = url.searchParams.get("store") ?? stores[0]?.key ?? "rh";
  const view = url.searchParams.get("view") ?? "open";
  const q = url.searchParams.get("q");
  const store = stores.find((s) => s.key === storeKey) ?? stores[0];
  const [tickets, eta] = await Promise.all([
    listTickets(session.shop, { storeKey: q ? null : storeKey, status: q ? null : view, q }),
    store ? etaForStore(session.shop, store) : null,
  ]);
  const tz = store?.timezone ?? "America/Toronto";
  const now = Date.now();
  return {
    stores: stores.map((s) => ({ key: s.key, name: s.name })),
    storeKey,
    view,
    q: q ?? "",
    eta,
    counts: {
      open: tickets.filter((t) => ["received", "in_progress", "on_hold"].includes(t.status)).length,
      ready: tickets.filter((t) => t.status === "ready").length,
    },
    tickets: tickets.map((t) => ({
      id: t.id,
      tag: t.tagNumber,
      store: t.storeKey,
      status: t.status,
      name: t.customerName,
      contact: [t.phone, t.email].filter(Boolean).join(" · "),
      services: (t.services as Array<{ name: string }>).map((s) => s.name).join(", "),
      equipment: t.equipment,
      created: fmt(t.createdAt, tz),
      waitingH: Math.round(((now - t.createdAt.getTime()) / 3600000) * 10) / 10,
      eta: fmt(t.etaAt, tz, false),
      overdue: Boolean(t.etaAt && t.etaAt.getTime() < now && ["received", "in_progress", "on_hold"].includes(t.status)),
      paid: t.paid,
      order: t.orderName,
      missing: !t.email && !t.phone,
      next: NEXT_STATUSES[t.status as TicketStatus] ?? [],
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const next = String(form.get("status") ?? "") as TicketStatus;
  try {
    await setStatus(session.shop, id, next, staffIdentity(session, sessionToken));
    return { ok: true, id, status: next };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export default function ServicesBoard() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };
  const move = (id: string, status: string) => fetcher.submit({ id, status }, { method: "POST" });
  const busy = fetcher.state !== "idle";
  const groups: Array<{ key: string; label: string; statuses: string[] }> =
    data.view === "open"
      ? [
          { key: "received", label: "Not started", statuses: ["received"] },
          { key: "in_progress", label: "In progress", statuses: ["in_progress"] },
          { key: "on_hold", label: "On hold", statuses: ["on_hold"] },
        ]
      : [{ key: "all", label: "Results", statuses: ["received", "in_progress", "on_hold", "ready", "picked_up", "cancelled"] }];

  return (
    <s-page heading={`Services · ${data.stores.find((s) => s.key === data.storeKey)?.name ?? data.storeKey}`}>
      <s-button slot="primary-action" href="/app/services/qr">
        QR codes
      </s-button>
      <s-button slot="secondary-actions" href="/app/services/settings">
        Settings
      </s-button>
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-select label="Store" value={data.storeKey} onChange={(e: Event) => set("store", (e.target as HTMLSelectElement).value)}>
            {data.stores.map((s) => (
              <s-option key={s.key} value={s.key}>
                {s.name}
              </s-option>
            ))}
          </s-select>
          <s-select label="Show" value={data.view} onChange={(e: Event) => set("view", (e.target as HTMLSelectElement).value)}>
            <s-option value="open">Open ({data.counts.open})</s-option>
            <s-option value="ready">Ready for pickup ({data.counts.ready})</s-option>
            <s-option value="done">Picked up / cancelled</s-option>
          </s-select>
          <s-text-field
            label="Search tag / name / phone / order"
            value={data.q}
            onChange={(e: Event) => set("q", (e.target as HTMLInputElement).value)}
          />
        </s-stack>
        {data.eta && (
          <s-paragraph>
            Current quote for new drop-offs: <strong>{data.eta.label}</strong> ({data.eta.date}) · {data.eta.ahead} open ahead. Change the rules under Settings.
          </s-paragraph>
        )}
      </s-section>

      {groups.map((g) => {
        const rows = data.tickets.filter((t) => g.statuses.includes(t.status));
        return (
          <s-section key={g.key} heading={`${g.label} (${rows.length})`}>
            {rows.length === 0 ? (
              <s-paragraph>Nothing here.</s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Tag</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Services</s-table-header>
                  <s-table-header>Dropped off</s-table-header>
                  <s-table-header>Pickup est.</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rows.map((t) => (
                    <s-table-row key={t.id}>
                      <s-table-cell>
                        <s-link href={`/app/services/${t.id}`}>
                          <strong>#{t.tag}</strong>
                        </s-link>
                        {data.q ? ` · ${t.store}` : ""}
                      </s-table-cell>
                      <s-table-cell>
                        {t.name}
                        <br />
                        <s-text color="subdued">{t.contact || "no contact"}</s-text>
                        {t.missing && (
                          <>
                            {" "}
                            <s-badge tone="warning">no contact</s-badge>
                          </>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {t.services}
                        {t.equipment ? <s-text color="subdued"> · {t.equipment}</s-text> : null}
                      </s-table-cell>
                      <s-table-cell>
                        {t.created}
                        <br />
                        <s-text color="subdued">{t.waitingH} h ago</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {t.eta}
                        {t.overdue && (
                          <>
                            {" "}
                            <s-badge tone="critical">overdue</s-badge>
                          </>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={t.status === "ready" ? "success" : t.status === "in_progress" ? "info" : t.status === "on_hold" ? "warning" : "neutral"}>
                          {STATUS_LABEL[t.status as TicketStatus] ?? t.status}
                        </s-badge>
                        {t.paid ? (
                          <>
                            {" "}
                            <s-badge tone="success">paid {t.order ?? ""}</s-badge>
                          </>
                        ) : null}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small-200">
                          {t.next
                            .filter((n) => n !== "cancelled")
                            .slice(0, 2)
                            .map((n) => (
                              <s-button key={n} variant={n === "ready" || n === "picked_up" ? "primary" : "secondary"} onClick={() => move(t.id, n)} {...(busy ? { disabled: true } : {})}>
                                {n === "in_progress" ? "Start" : n === "ready" ? "Done, notify" : n === "picked_up" ? "Picked up" : STATUS_LABEL[n]}
                              </s-button>
                            ))}
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>
        );
      })}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
