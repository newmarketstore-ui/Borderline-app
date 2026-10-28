import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  adjustPoints,
  getMemberWithLedger,
  staffIdentity,
  syncBalanceMetafield,
  type AdminGraphql,
} from "../models/loyalty.server";
import { enqueue, QUEUES } from "../jobs/queue.server";

// 会员详情：头部信息 + 流水（新的在上）+ 员工调分（写 adjust 流水，记员工身份，带幂等键防重复提交）。
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const member = await getMemberWithLedger(session.shop, String(params.memberId));
  if (!member) throw new Response("Member not found", { status: 404 });
  return {
    member: {
      id: member.id,
      customerGid: member.shopifyCustomerId,
      customerNumericId: member.shopifyCustomerId.split("/").pop() ?? "",
      name: [member.firstName, member.lastName].filter(Boolean).join(" ") || "(no name)",
      email: member.email,
      phone: member.phone,
      tier: member.tier,
      paidUntil: member.paidUntil?.toISOString().slice(0, 10) ?? null,
      balance: member.balanceCached,
      pending: member.pendingCached,
      source: member.source,
      createdAt: member.createdAt.toISOString().slice(0, 10),
    },
    ledger: member.ledger.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString().replace("T", " ").slice(0, 16),
      type: l.type,
      delta: l.delta,
      orderName: l.orderName,
      note: l.note,
      createdBy: l.createdBy,
      pendingUntil: l.availableAt > new Date() ? l.availableAt.toISOString().slice(0, 10) : null,
    })),
    // 每次渲染一个新键；同一次表单提交重放也只记一次
    idempotencyKey: crypto.randomUUID(),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const member = await getMemberWithLedger(session.shop, String(params.memberId), 0);
  if (!member) return { ok: false as const, errors: ["Member not found"] };

  const form = await request.formData();
  const delta = Number(String(form.get("delta") ?? "").trim());
  const reason = String(form.get("reason") ?? "").trim();
  const key = String(form.get("idempotencyKey") ?? "");
  const errors: string[] = [];
  if (!Number.isInteger(delta) || delta === 0) errors.push("Points must be a non-zero whole number (use - to deduct)");
  if (Math.abs(delta) > 100000) errors.push("Adjustments are limited to 100,000 points at a time");
  if (reason.length < 3) errors.push("Please give a reason (at least 3 characters)");
  if (!/^[0-9a-f-]{36}$/i.test(key)) errors.push("Form expired, reload the page and try again");
  if (errors.length) return { ok: false as const, errors };

  const result = await adjustPoints({
    memberId: member.id,
    delta,
    reason: reason.slice(0, 500),
    staff: staffIdentity(session, sessionToken),
    idempotencyKey: key,
  });

  // 当场用这次请求的 Admin 客户端同步 metafield；失败就交给队列重试
  let metafield: "synced" | "queued" = "synced";
  try {
    await syncBalanceMetafield(admin as unknown as AdminGraphql, member.id);
  } catch (e) {
    console.error("[loyalty] metafield sync after adjust failed, queued:", (e as Error).message);
    metafield = "queued";
    await enqueue(QUEUES.syncBalance, { shop: session.shop, memberId: member.id }).catch(() => undefined);
  }
  return { ok: true as const, applied: result.applied, balance: result.member.balanceCached, metafield };
};

const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;

export default function LoyaltyMember() {
  const { member, ledger, idempotencyKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");

  const saving = fetcher.state !== "idle";
  const errors = fetcher.data && !fetcher.data.ok ? fetcher.data.errors : [];

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show(fetcher.data.applied ? `Saved. New balance ${fetcher.data.balance}` : "Already saved");
      setDelta("");
      setReason("");
    }
  }, [fetcher.data, shopify]);

  const submit = () =>
    fetcher.submit({ delta, reason, idempotencyKey }, { method: "POST" });

  return (
    <s-page heading={member.name}>
      <s-link slot="breadcrumb-actions" href="/app/loyalty">
        Loyalty members
      </s-link>

      {fetcher.data?.ok && fetcher.data.metafield === "queued" && (
        <s-banner tone="warning" heading="Points saved; customer metafield update queued">
          <s-paragraph>
            The ledger is updated. Writing borderline.points_balance to the customer failed and will be retried in the
            background (usually a missing write_customers scope before the app is re-authorised).
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Member">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="base">
            <s-text>Balance: {member.balance} pts</s-text>
            {member.pending !== 0 && <s-text>Pending: {member.pending} pts</s-text>}
            <s-badge tone={member.tier === "paid" ? "success" : "neutral"}>{member.tier}</s-badge>
            {member.paidUntil && <s-text>Paid until {member.paidUntil}</s-text>}
          </s-stack>
          <s-text>Email: {member.email ?? "—"}</s-text>
          <s-text>Phone: {member.phone ?? "—"}</s-text>
          <s-text>
            Member since {member.createdAt} (source: {member.source}) ·{" "}
            <s-link href={`shopify://admin/customers/${member.customerNumericId}`} target="_blank">
              Open customer in Shopify
            </s-link>
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Adjust points">
        {errors.length > 0 && (
          <s-banner tone="critical" heading="Please fix and try again">
            <s-unordered-list>
              {errors.map((e: string) => (
                <s-list-item key={e}>{e}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Points (+ to add, - to deduct)"
            name="delta"
            step={1}
            value={delta}
            onInput={(e: Event) => setDelta(fieldValue(e))}
          />
          <s-text-field
            label="Reason (saved in the ledger)"
            name="reason"
            value={reason}
            onInput={(e: Event) => setReason(fieldValue(e))}
          />
          <s-button variant="primary" onClick={submit} {...(saving ? { loading: true } : {})}>
            Save adjustment
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Points history">
        {ledger.length === 0 ? (
          <s-paragraph>No ledger entries yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Date</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Note</s-table-header>
              <s-table-header>By</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {ledger.map((l) => (
                <s-table-row key={l.id}>
                  <s-table-cell>{l.createdAt}</s-table-cell>
                  <s-table-cell>
                    {l.type}
                    {l.pendingUntil ? ` (pending until ${l.pendingUntil})` : ""}
                  </s-table-cell>
                  <s-table-cell>{l.delta > 0 ? `+${l.delta}` : l.delta}</s-table-cell>
                  <s-table-cell>{l.orderName ?? "—"}</s-table-cell>
                  <s-table-cell>{l.note ?? "—"}</s-table-cell>
                  <s-table-cell>{l.createdBy}</s-table-cell>
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
