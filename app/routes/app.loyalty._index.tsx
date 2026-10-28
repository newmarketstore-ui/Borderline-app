import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { searchMembers } from "../models/loyalty.server";

// 会员列表：按邮箱 / 姓名 / 手机 / Customer ID 搜；空搜索显示最近更新的 50 个。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  const members = await searchMembers(session.shop, q);
  return {
    q,
    members: members.map((m) => ({
      id: m.id,
      name: [m.firstName, m.lastName].filter(Boolean).join(" ") || "—",
      email: m.email ?? "—",
      phone: m.phone ?? "—",
      tier: m.tier,
      balance: m.balanceCached,
      pending: m.pendingCached,
    })),
  };
};

const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;

export default function LoyaltyMembers() {
  const { q, members } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [query, setQuery] = useState(q);

  const search = (value = query) => navigate(`/app/loyalty?q=${encodeURIComponent(value.trim())}`);

  return (
    <s-page heading="Loyalty members">
      <s-button slot="primary-action" href="/app/loyalty/settings">
        Settings
      </s-button>

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-search-field
            label="Search members"
            placeholder="Email, name, phone or customer ID"
            value={query}
            onInput={(e: Event) => setQuery(fieldValue(e))}
            // change 在回车 / 失焦时触发：直接按当前值搜索
            onChange={(e: Event) => search(fieldValue(e))}
          />
          <s-button variant="primary" onClick={() => search()}>
            Search
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading={q ? `Results for "${q}"` : "Recently updated members"}>
        {members.length === 0 ? (
          <s-paragraph>
            {q
              ? "No members match this search."
              : "No members yet. Members are created when a customer's paid order earns points, or by the Appstle migration."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header listSlot="secondary">Email</s-table-header>
              <s-table-header>Phone</s-table-header>
              <s-table-header>Tier</s-table-header>
              <s-table-header format="numeric">Balance</s-table-header>
              <s-table-header format="numeric">Pending</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {members.map((m) => (
                <s-table-row key={m.id}>
                  <s-table-cell>
                    <s-link href={`/app/loyalty/${m.id}`}>{m.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{m.email}</s-table-cell>
                  <s-table-cell>{m.phone}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={m.tier === "paid" ? "success" : "neutral"}>{m.tier}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{m.balance}</s-table-cell>
                  <s-table-cell>{m.pending}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
