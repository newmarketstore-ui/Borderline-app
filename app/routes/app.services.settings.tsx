// 服务设置：每店（名称 / tag 号段 / 营业时间 / 地址 / 预计日期分档）+ 服务目录（工时 / 价格 / 哪些店提供 / 需要的字段）。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";

import { parseEtaRules, STORE_KEYS, type EtaRules } from "../lib/serviceRules";
import { requireModule } from "../models/modules.server";
import { getCatalog, getStores, saveServiceType, saveStore } from "../models/services.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "service_tickets");
  const [stores, catalog] = await Promise.all([getStores(session.shop, { includeInactive: true }), getCatalog(session.shop, { includeInactive: true })]);
  return {
    stores: stores.map((s) => ({
      key: s.key,
      name: s.name,
      tagMin: String(s.tagMin),
      tagMax: String(s.tagMax),
      techsPerDay: String(s.techsPerDay),
      openHour: String(s.openHour),
      closeHour: String(s.closeHour),
      address: s.address ?? "",
      hoursText: s.hoursText ?? "",
      phone: s.phone ?? "",
      active: s.active,
      eta: parseEtaRules(s.etaRules),
    })),
    catalog: catalog.map((c) => ({
      key: c.key,
      name: c.name,
      category: c.category,
      durationMin: String(c.durationMin),
      price: c.priceCents === null ? "" : (c.priceCents / 100).toFixed(2),
      memberPrice: c.memberPriceCents === null ? "" : (c.memberPriceCents / 100).toFixed(2),
      needsEdgeAngle: c.needsEdgeAngle,
      needsBodyMetrics: c.needsBodyMetrics,
      stores: c.stores,
      active: c.active,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const n = (k: string, d: number) => {
    const v = Number(form.get(k));
    return Number.isFinite(v) ? v : d;
  };
  try {
    if (intent === "store") {
      const key = String(form.get("key"));
      const tiers = JSON.parse(String(form.get("tiers") ?? "[]")) as EtaRules["tiers"];
      await saveStore(session.shop, key, {
        name: String(form.get("name") ?? "").trim() || undefined,
        tagMin: n("tagMin", 1),
        tagMax: n("tagMax", 2000),
        techsPerDay: n("techsPerDay", 1),
        openHour: n("openHour", 10),
        closeHour: n("closeHour", 19),
        address: String(form.get("address") ?? "") || null,
        hoursText: String(form.get("hoursText") ?? "") || null,
        phone: String(form.get("phone") ?? "") || null,
        active: String(form.get("active")) === "true",
        etaRules: { tiers, sameDayUntilHour: n("sameDayUntilHour", 15), closedWeekdays: String(form.get("closedWeekdays") ?? "").split(",").map((s) => Number(s.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) },
      });
    } else if (intent === "service") {
      const key = String(form.get("key"));
      const cents = (k: string) => {
        const v = String(form.get(k) ?? "").trim();
        return v === "" ? null : Math.round(Number(v) * 100);
      };
      await saveServiceType(session.shop, key, {
        name: String(form.get("name") ?? "").trim() || undefined,
        durationMin: n("durationMin", 30),
        priceCents: cents("price"),
        memberPriceCents: cents("memberPrice"),
        needsEdgeAngle: String(form.get("needsEdgeAngle")) === "true",
        needsBodyMetrics: String(form.get("needsBodyMetrics")) === "true",
        stores: STORE_KEYS.filter((s) => String(form.get(`store_${s}`)) === "true"),
        active: String(form.get("active")) === "true",
      });
    } else return { ok: false, error: "Unknown action" };
    return { ok: true, intent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

type StoreForm = ReturnType<typeof useLoaderData<typeof loader>>["stores"][number];
type ServiceForm = ReturnType<typeof useLoaderData<typeof loader>>["catalog"][number];

export default function ServiceSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <s-page heading="Service settings">
      <s-link slot="breadcrumb-actions" href="/app/services">
        Services
      </s-link>
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}
      {fetcher.data?.ok && <s-banner tone="success" heading="Saved" />}
      <s-section>
        <s-paragraph>
          Pickup estimate rule: count the open tickets ahead in the store, pick the first tier whose &quot;up to N ahead&quot; fits, add that many days; &quot;0 days&quot; after the
          same-day cutoff hour becomes tomorrow; closed weekdays are skipped. Customers see the resulting date and it refreshes as the queue moves.
        </s-paragraph>
      </s-section>
      {data.stores.map((s) => (
        <StoreCard key={s.key} s={s} busy={busy} onSave={(fields) => fetcher.submit({ intent: "store", key: s.key, ...fields }, { method: "POST" })} />
      ))}
      <s-section heading="Service catalogue (shown on the drop-off form)">
        <s-stack direction="block" gap="base">
          {data.catalog.map((c) => (
            <ServiceRow key={c.key} c={c} busy={busy} onSave={(fields) => fetcher.submit({ intent: "service", key: c.key, ...fields }, { method: "POST" })} />
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function StoreCard({ s, busy, onSave }: { s: StoreForm; busy: boolean; onSave: (f: Record<string, string>) => void }) {
  const [f, setF] = useState({ ...s, closedWeekdays: s.eta.closedWeekdays.join(","), sameDayUntilHour: String(s.eta.sameDayUntilHour) });
  const [tiers, setTiers] = useState(s.eta.tiers.map((t) => ({ maxAhead: t.maxAhead === null ? "" : String(t.maxAhead), days: String(t.days) })));
  const up = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = () =>
    onSave({
      name: f.name,
      tagMin: f.tagMin,
      tagMax: f.tagMax,
      techsPerDay: f.techsPerDay,
      openHour: f.openHour,
      closeHour: f.closeHour,
      address: f.address,
      hoursText: f.hoursText,
      phone: f.phone,
      active: f.active ? "true" : "false",
      sameDayUntilHour: f.sameDayUntilHour,
      closedWeekdays: f.closedWeekdays,
      tiers: JSON.stringify(tiers.map((t) => ({ maxAhead: t.maxAhead === "" ? null : Number(t.maxAhead), days: Number(t.days) }))),
    });
  return (
    <s-section heading={`${s.name} (${s.key})`}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-text-field label="Name" value={f.name} onInput={up("name")} />
          <s-number-field label="Tag from" value={f.tagMin} onInput={up("tagMin")} />
          <s-number-field label="Tag to" value={f.tagMax} onInput={up("tagMax")} />
          <s-number-field label="Techs per day" value={f.techsPerDay} onInput={up("techsPerDay")} />
          <s-number-field label="Opens (hour)" value={f.openHour} onInput={up("openHour")} />
          <s-number-field label="Closes (hour)" value={f.closeHour} onInput={up("closeHour")} />
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-text-field label="Address (in notifications)" value={f.address} onInput={up("address")} />
          <s-text-field label="Hours text" value={f.hoursText} onInput={up("hoursText")} />
          <s-text-field label="Phone" value={f.phone} onInput={up("phone")} />
        </s-stack>
        <s-text>
          <strong>Pickup estimate tiers</strong> (first matching row wins; leave &quot;up to&quot; empty for the last catch-all row)
        </s-text>
        {tiers.map((t, i) => (
          <s-stack key={i} direction="inline" gap="base" alignItems="end">
            <s-number-field label="Up to N open ahead" value={t.maxAhead} onInput={(e: Event) => setTiers(tiers.map((x, j) => (j === i ? { ...x, maxAhead: (e.target as HTMLInputElement).value } : x)))} />
            <s-number-field label="→ days" value={t.days} onInput={(e: Event) => setTiers(tiers.map((x, j) => (j === i ? { ...x, days: (e.target as HTMLInputElement).value } : x)))} />
            <s-button variant="tertiary" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
              Remove
            </s-button>
          </s-stack>
        ))}
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-button onClick={() => setTiers([...tiers, { maxAhead: "", days: "2" }])}>Add tier</s-button>
          <s-number-field label="Same-day cutoff hour" value={f.sameDayUntilHour} onInput={up("sameDayUntilHour")} />
          <s-text-field label="Closed weekdays (0=Sun,6=Sat, comma)" value={f.closedWeekdays} onInput={up("closedWeekdays")} />
          <s-checkbox label="Store active" checked={f.active} onChange={(e: Event) => setF({ ...f, active: (e.target as HTMLInputElement).checked })} />
          <s-button variant="primary" onClick={save} {...(busy ? { disabled: true } : {})}>
            Save {s.key.toUpperCase()}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function ServiceRow({ c, busy, onSave }: { c: ServiceForm; busy: boolean; onSave: (f: Record<string, string>) => void }) {
  const [f, setF] = useState(c);
  const up = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const tog = (k: "needsEdgeAngle" | "needsBodyMetrics" | "active") => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).checked });
  const storeOn = (s: string) => f.stores.includes(s);
  const toggleStore = (s: string) => (e: Event) => setF({ ...f, stores: (e.target as HTMLInputElement).checked ? [...f.stores, s] : f.stores.filter((x) => x !== s) });
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field label={`${c.key} · ${c.category}`} value={f.name} onInput={up("name")} />
          <s-number-field label="Minutes" value={f.durationMin} onInput={up("durationMin")} />
          <s-number-field label="Price $" value={f.price} onInput={up("price")} />
          <s-number-field label="Member $" value={f.memberPrice} onInput={up("memberPrice")} />
        </s-stack>
        <s-stack direction="inline" gap="base" alignItems="center">
          {STORE_KEYS.map((s) => (
            <s-checkbox key={s} label={s.toUpperCase()} checked={storeOn(s)} onChange={toggleStore(s)} />
          ))}
          <s-checkbox label="asks edge angle" checked={f.needsEdgeAngle} onChange={tog("needsEdgeAngle")} />
          <s-checkbox label="asks height/weight or stance" checked={f.needsBodyMetrics} onChange={tog("needsBodyMetrics")} />
          <s-checkbox label="active" checked={f.active} onChange={tog("active")} />
          <s-button
            onClick={() =>
              onSave({
                name: f.name,
                durationMin: f.durationMin,
                price: f.price,
                memberPrice: f.memberPrice,
                needsEdgeAngle: f.needsEdgeAngle ? "true" : "false",
                needsBodyMetrics: f.needsBodyMetrics ? "true" : "false",
                active: f.active ? "true" : "false",
                ...Object.fromEntries(STORE_KEYS.map((s) => [`store_${s}`, storeOn(s) ? "true" : "false"])),
              })
            }
            {...(busy ? { disabled: true } : {})}
          >
            Save
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
