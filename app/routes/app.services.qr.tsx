// 每店的扫码链接 + 二维码（PNG data URL，可直接右键另存去印海报）。
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import QRCode from "qrcode";

import { requireModule } from "../models/modules.server";
import { getStores } from "../models/services.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await requireModule(session.shop, "service_tickets");
  const base = (process.env.SERVICE_STATUS_BASE ?? "https://borderlinestore.ca/apps/loyalty-1").replace(/\/$/, "");
  const stores = await getStores(session.shop);
  const items = await Promise.all(
    stores.map(async (s) => {
      const url = `${base}/service/${s.key}`;
      return { key: s.key, name: s.name, url, png: await QRCode.toDataURL(url, { width: 600, margin: 2, color: { dark: "#202321", light: "#ffffff" } }) };
    }),
  );
  return { items, base };
};

export default function QrPage() {
  const { items, base } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Drop-off QR codes">
      <s-link slot="breadcrumb-actions" href="/app/services">
        Services
      </s-link>
      <s-section>
        <s-paragraph>
          One code per store. Print it at the service counter. Customers scan, fill the form (tag number, contact, services) and get a confirmation with
          their estimated pickup date. Links are under {base}/service/… so logged-in customers are recognised automatically.
        </s-paragraph>
      </s-section>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
        {items.map((i) => (
          <s-section key={i.key} heading={i.name}>
            <s-stack direction="block" gap="small-200" alignItems="center">
              <img src={i.png} alt={`QR ${i.name}`} width={240} height={240} />
              <s-link href={i.url} target="_blank">
                {i.url}
              </s-link>
              <s-text color="subdued">Right-click the image to save the PNG for the poster.</s-text>
            </s-stack>
          </s-section>
        ))}
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
