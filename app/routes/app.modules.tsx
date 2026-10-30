// Modules：开关各功能模块（只开着的才出现在导航和首页）。以后新模块在 app/models/modules.server.ts 的 MODULES 里登记。
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { staffIdentity } from "../models/loyalty.server";
import { getModules, setModule, type ModuleKey } from "../models/modules.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { modules: await getModules(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const key = String(form.get("key") ?? "") as ModuleKey;
  const enabled = String(form.get("enabled")) === "true";
  try {
    await setModule(session.shop, key, enabled, staffIdentity(session, sessionToken));
    return { ok: true, key, enabled };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

export default function Modules() {
  const { modules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const toggle = (key: string, enabled: boolean) => fetcher.submit({ key, enabled: enabled ? "true" : "false" }, { method: "POST" });
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Modules">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      {fetcher.data && !fetcher.data.ok && <s-banner tone="critical" heading={fetcher.data.error} />}
      <s-section>
        <s-paragraph>
          Turn modules on or off for this store. Off = hidden from the navigation and the home page; data is kept. Modules
          marked &quot;not built yet&quot; are placeholders for the roadmap.
        </s-paragraph>
      </s-section>
      {modules.map((m) => (
        <s-section key={m.key} heading={m.name}>
          <s-stack direction="block" gap="small-200">
            <s-text>{m.description}</s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={m.enabled ? "success" : m.available ? "neutral" : "info"}>
                {m.enabled ? "On" : m.available ? "Off" : "Not built yet"}
              </s-badge>
              {m.available && (
                <s-button variant={m.enabled ? "secondary" : "primary"} onClick={() => toggle(m.key, !m.enabled)} {...(busy ? { disabled: true } : {})}>
                  {m.enabled ? "Turn off" : "Turn on"}
                </s-button>
              )}
              {m.enabled && m.entry && <s-link href={m.entry}>Open</s-link>}
              {m.updatedAt && (
                <s-text color="subdued">
                  changed by {m.updatedBy ?? "staff"} on {m.updatedAt.slice(0, 10)}
                </s-text>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
