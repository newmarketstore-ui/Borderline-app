// 知识库：每篇一张卡（标题 / 类别 / 正文 Markdown / 开关），新增、删除、一键恢复默认 + 从 Shopify 拉门店地址与官方政策原文。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getOfflineAdmin, staffIdentity } from "../models/loyalty.server";
import { requireModule } from "../models/modules.server";
import { deleteKb, listKb, seedKb, upsertKb } from "../models/support.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "ai_support");
  const docs = await listKb(session.shop);
  const chars = docs.filter((d) => d.enabled).reduce((a, d) => a + d.body.length, 0);
  return {
    docs: docs.map((d) => ({ key: d.key, title: d.title, category: d.category, body: d.body, enabled: d.enabled, sortOrder: d.sortOrder, sourceUrl: d.sourceUrl ?? "", updatedBy: d.updatedBy, updatedAt: d.updatedAt.toISOString().slice(0, 16).replace("T", " ") })),
    approxTokens: Math.round(chars / 4),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");
  const by = staffIdentity(session, sessionToken);
  try {
    if (intent === "seed" || intent === "seed_overwrite") {
      let admin = null;
      try {
        admin = (await getOfflineAdmin(session.shop)).admin;
      } catch (e) {
        console.warn("[support] no offline admin for seed:", (e as Error).message);
      }
      const r = await seedKb(session.shop, admin, by, intent === "seed_overwrite");
      return { ok: true, message: `Wrote ${r.written.length} doc(s)${r.skipped.length ? `, kept ${r.skipped.length} existing` : ""}.` };
    }
    const key = String(form.get("key") ?? "");
    if (intent === "delete") {
      await deleteKb(session.shop, key);
      return { ok: true, message: `Deleted ${key}` };
    }
    await upsertKb(
      session.shop,
      key,
      {
        title: String(form.get("title") ?? "").trim().slice(0, 120),
        category: String(form.get("category") ?? "other"),
        body: String(form.get("body") ?? "").trim().slice(0, 20_000),
        sourceUrl: String(form.get("sourceUrl") ?? "").trim() || null,
        enabled: form.get("enabled") === "on",
        sortOrder: Math.round(Number(form.get("sortOrder") ?? 500) || 500),
      },
      by,
    );
    return { ok: true, message: `Saved ${key}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

const CATEGORIES = ["policy", "store", "product", "service", "loyalty", "other"];

export default function SupportKb() {
  const { docs, approxTokens } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <s-page heading={`Knowledge base · ${docs.length} docs`}>
      <s-link slot="breadcrumb-actions" href="/app/support">
        Support chat
      </s-link>
      <s-button slot="primary-action" disabled={busy} onClick={() => fetcher.submit({ intent: "seed" }, { method: "POST" })}>
        Add missing defaults
      </s-button>
      <s-button slot="secondary-actions" disabled={busy} onClick={() => fetcher.submit({ intent: "seed_overwrite" }, { method: "POST" })}>
        Restore all defaults (overwrites edits)
      </s-button>
      {fetcher.data?.ok && <s-banner tone="success" heading={fetcher.data.message} />}
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}

      <s-section>
        <s-paragraph>
          Every enabled doc goes into the assistant’s prompt on every reply (≈{approxTokens.toLocaleString()} tokens now; it is cached, so cost stays low under ~15k). Write plain facts in English; the assistant answers in the customer’s language. Prices, stock and product specs do NOT belong here — they are read live.
        </s-paragraph>
      </s-section>

      {docs.map((d) => (
        <s-section key={d.key} heading={`${d.title} [${d.key}]${d.enabled ? "" : " · off"}`}>
          <fetcher.Form method="post">
            <input type="hidden" name="key" value={d.key} />
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base">
                <s-text-field name="title" label="Title" defaultValue={d.title} />
                <s-select name="category" label="Category" value={d.category}>
                  {CATEGORIES.map((c) => (
                    <s-option key={c} value={c}>
                      {c}
                    </s-option>
                  ))}
                </s-select>
                <s-number-field name="sortOrder" label="Order" defaultValue={String(d.sortOrder)} />
                <s-checkbox name="enabled" label="Enabled" defaultChecked={d.enabled} />
              </s-stack>
              <s-text-area name="body" label="Content (Markdown)" defaultValue={d.body} rows={Math.min(18, Math.max(4, d.body.split("\n").length + 1))} />
              <s-text-field name="sourceUrl" label="Source URL (optional)" defaultValue={d.sourceUrl} />
              <s-stack direction="inline" gap="small-200">
                <s-button type="submit" variant="primary" disabled={busy}>
                  Save
                </s-button>
                <s-button tone="critical" disabled={busy} onClick={() => fetcher.submit({ intent: "delete", key: d.key }, { method: "POST" })}>
                  Delete
                </s-button>
                <s-text color="subdued">
                  {d.updatedBy ? `${d.updatedBy} · ` : ""}
                  {d.updatedAt}
                </s-text>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        </s-section>
      ))}

      <s-section heading="Add a doc">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="base">
              <s-text-field name="key" label="Key (a-z, 0-9, _)" placeholder="holiday_hours" />
              <s-text-field name="title" label="Title" />
              <s-select name="category" label="Category" value="other">
                {CATEGORIES.map((c) => (
                  <s-option key={c} value={c}>
                    {c}
                  </s-option>
                ))}
              </s-select>
              <s-number-field name="sortOrder" label="Order" defaultValue="500" />
              <s-checkbox name="enabled" label="Enabled" defaultChecked />
            </s-stack>
            <s-text-area name="body" label="Content (Markdown)" rows={6} />
            <s-button type="submit" variant="primary" disabled={busy}>
              Add
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
