import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { getModules } from "../models/modules.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const modules = await getModules(session.shop);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", enabled: modules.filter((m) => m.enabled).map((m) => m.key) };
};

export default function App() {
  const { apiKey, enabled } = useLoaderData<typeof loader>();
  const on = (k: string) => (enabled as string[]).includes(k);

  // 导航：只放开着的模块；积分是主项目，永远在。
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        {on("loyalty") && <s-link href="/app/loyalty">Members</s-link>}
        {on("loyalty") && <s-link href="/app/loyalty/settings">Points rules</s-link>}
        {on("service_tickets") && <s-link href="/app/services">Services</s-link>}
        {on("store_metrics") && <s-link href="/app/store-report">Store daily report</s-link>}
        <s-link href="/app/modules">Modules</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
