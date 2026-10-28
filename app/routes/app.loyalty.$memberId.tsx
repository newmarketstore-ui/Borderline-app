import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  adjustPoints,
  getAdminForShop,
  getLoyaltySettings,
  getMemberWithLedger,
  getRedeemWindows,
  staffIdentity,
  syncBalanceMetafield,
} from "../models/loyalty.server";
import { syncMembershipForCustomer } from "../models/membership.server";
import { issueRedemption } from "../models/redemption.server";
import { enqueue, QUEUES } from "../jobs/queue.server";
import { hasMemberTag, isMember } from "../lib/membership";
import {
  formatCents,
  quoteRedemption,
  redeemPointOptions,
  WEEKDAY_NAMES,
  type RedeemChannel,
} from "../lib/redeemMath";

// 会员详情：头部信息 + 会员资格 + 兑换（发一次性专属码）+ 员工调分 + 流水（新的在上）。
// 员工身份来自在线 session（useOnlineTokens）；Shopify 写操作（发码、拉会员资料）走离线 token，不受员工权限影响。
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const member = await getMemberWithLedger(session.shop, String(params.memberId));
  if (!member) throw new Response("Member not found", { status: 404 });
  const settings = await getLoyaltySettings(session.shop);
  const windows = await getRedeemWindows(session.shop, settings);
  const now = new Date();
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
      tags: member.tags,
      hasTag: hasMemberTag(member.tags, settings.memberTag),
      isMember: isMember(member, now, settings.memberTag),
      membershipSyncedAt: member.membershipSyncedAt?.toISOString().replace("T", " ").slice(0, 16) ?? null,
    },
    memberships: member.memberships.map((m) => ({
      id: m.id,
      source: m.source,
      externalId: m.externalId,
      planName: m.planName,
      status: m.status,
      startedAt: m.startedAt?.toISOString().slice(0, 10) ?? null,
      renewsAt: m.renewsAt?.toISOString().slice(0, 10) ?? null,
      endsAt: m.endsAt?.toISOString().slice(0, 10) ?? null,
    })),
    redemptions: member.redemptions.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString().replace("T", " ").slice(0, 16),
      code: r.discountCode,
      points: r.points,
      amount: formatCents(r.amountCents),
      channel: r.channel,
      status: r.status,
      expiresAt: (r.expiresAt ? torontoTime(r.expiresAt) : null),
      issuedBy: r.issuedBy,
    })),
    ledger: member.ledger.map((l) => ({
      id: l.id,
      createdAt: l.createdAt.toISOString().replace("T", " ").slice(0, 16),
      type: l.type,
      delta: l.delta,
      orderName: l.orderName,
      note: l.note,
      createdBy: l.createdBy,
      pendingUntil: l.availableAt > now ? l.availableAt.toISOString().slice(0, 10) : null,
    })),
    redeemRules: {
      redeemPointsPerDollar: settings.redeemPointsPerDollar,
      minRedeemPoints: settings.minRedeemPoints,
      redeemStepPoints: settings.redeemStepPoints,
      redeemAmountIsTaxInclusive: settings.redeemAmountIsTaxInclusive,
      assumedTaxRate: settings.assumedTaxRate,
      redeemRounding: settings.redeemRounding,
      redeemRequiresMember: settings.redeemRequiresMember,
    },
    redeemExpiryHours: settings.redeemExpiryHours,
    windows,
    // 每次渲染新键；同一次表单提交重放也只记一次 / 只发一张码
    idempotencyKey: crypto.randomUUID(),
    redeemKey: crypto.randomUUID(),
  };
};

type ActionResult =
  | { intent: "adjust"; ok: true; applied: boolean; balance: number; metafield: "synced" | "queued" }
  | { intent: "redeem"; ok: true; applied: boolean; code: string; amount: string; points: number; expiresAt: string }
  | { intent: "membership"; ok: true; isMember: boolean }
  | { intent: string; ok: false; errors: string[] };

const KEY_RE = /^[0-9a-f-]{36}$/i;

const torontoTime = (d: Date) =>
  d.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "short", timeStyle: "short" });

export const action = async ({ request, params }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, sessionToken } = await authenticate.admin(request);
  const member = await getMemberWithLedger(session.shop, String(params.memberId), 0);
  if (!member) return { intent: "unknown", ok: false, errors: ["Member not found"] };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "adjust");
  const staff = staffIdentity(session, sessionToken);

  if (intent === "redeem") {
    const points = Number(String(form.get("points") ?? "").trim());
    const channel = String(form.get("channel") ?? "") as RedeemChannel;
    const key = String(form.get("idempotencyKey") ?? "");
    const errors: string[] = [];
    if (channel !== "pos" && channel !== "web") errors.push("Pick POS or online");
    if (!KEY_RE.test(key)) errors.push("Form expired, reload the page and try again");
    if (errors.length) return { intent, ok: false, errors };
    const res = await issueRedemption(
      { memberId: member.id, points, channel, issuedBy: staff, idempotencyKey: key },
      { getAdmin: getAdminForShop },
    );
    await enqueue(QUEUES.syncBalance, { shop: session.shop, memberId: member.id }).catch(() => undefined);
    if (!res.ok) return { intent, ok: false, errors: [res.error] };
    return {
      intent,
      ok: true,
      applied: res.applied,
      code: res.redemption.discountCode ?? "",
      amount: formatCents(res.redemption.amountCents),
      points: res.redemption.points,
      expiresAt: (res.redemption.expiresAt ? torontoTime(res.redemption.expiresAt) : ""),
    };
  }

  if (intent === "membership") {
    const settings = await getLoyaltySettings(session.shop);
    const synced = await syncMembershipForCustomer(session.shop, await getAdminForShop(session.shop), member.shopifyCustomerId, {
      memberTag: settings.memberTag,
      createIfMember: false,
    });
    if (!synced) return { intent, ok: false, errors: ["Customer not found in Shopify"] };
    return { intent, ok: true, isMember: isMember(synced, new Date(), settings.memberTag) };
  }

  // 调分
  const delta = Number(String(form.get("delta") ?? "").trim());
  const reason = String(form.get("reason") ?? "").trim();
  const key = String(form.get("idempotencyKey") ?? "");
  const errors: string[] = [];
  if (!Number.isInteger(delta) || delta === 0) errors.push("Points must be a non-zero whole number (use - to deduct)");
  if (Math.abs(delta) > 100000) errors.push("Adjustments are limited to 100,000 points at a time");
  if (reason.length < 3) errors.push("Please give a reason (at least 3 characters)");
  if (!KEY_RE.test(key)) errors.push("Form expired, reload the page and try again");
  if (errors.length) return { intent: "adjust", ok: false, errors };

  const result = await adjustPoints({
    memberId: member.id,
    delta,
    reason: reason.slice(0, 500),
    staff,
    idempotencyKey: key,
  });

  // 当场用店铺离线客户端同步 metafield（不用员工在线 token）；失败就交给队列重试
  let metafield: "synced" | "queued" = "synced";
  try {
    await syncBalanceMetafield(await getAdminForShop(session.shop), member.id);
  } catch (e) {
    console.error("[loyalty] metafield sync after adjust failed, queued:", (e as Error).message);
    metafield = "queued";
    await enqueue(QUEUES.syncBalance, { shop: session.shop, memberId: member.id }).catch(() => undefined);
  }
  return { intent: "adjust", ok: true, applied: result.applied, balance: result.member.balanceCached, metafield };
};

const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;

function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <s-banner tone="critical" heading="Please fix and try again">
      <s-unordered-list>
        {errors.map((e) => (
          <s-list-item key={e}>{e}</s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}

export default function LoyaltyMember() {
  const data = useLoaderData<typeof loader>();
  const { member, memberships, redemptions, ledger, idempotencyKey, redeemKey, redeemRules, windows } = data;
  const adjustFetcher = useFetcher<typeof action>();
  const redeemFetcher = useFetcher<typeof action>();
  const membershipFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");

  const options = useMemo(() => redeemPointOptions(member.balance, redeemRules), [member.balance, redeemRules]);
  const [points, setPoints] = useState(() => String(options[0] ?? ""));
  const [channel, setChannel] = useState<RedeemChannel>("pos");
  const quote = useMemo(
    () =>
      points
        ? quoteRedemption(
            { points: Number(points), channel, at: new Date(), isMember: member.isMember, balance: member.balance },
            redeemRules,
            windows,
          )
        : null,
    [points, channel, member.isMember, member.balance, redeemRules, windows],
  );

  const adjustData = adjustFetcher.data;
  const redeemData = redeemFetcher.data;
  const adjustErrors = adjustData && !adjustData.ok ? adjustData.errors : [];
  const redeemErrors = redeemData && !redeemData.ok ? redeemData.errors : [];
  const membershipErrors = membershipFetcher.data && !membershipFetcher.data.ok ? membershipFetcher.data.errors : [];

  useEffect(() => {
    if (adjustData?.ok && adjustData.intent === "adjust") {
      shopify.toast.show(adjustData.applied ? `Saved. New balance ${adjustData.balance}` : "Already saved");
      setDelta("");
      setReason("");
    }
  }, [adjustData, shopify]);
  useEffect(() => {
    if (redeemData?.ok && redeemData.intent === "redeem") shopify.toast.show(`Code ${redeemData.code} issued`);
  }, [redeemData, shopify]);
  useEffect(() => {
    const d = membershipFetcher.data;
    if (d?.ok && d.intent === "membership") shopify.toast.show(d.isMember ? "Membership refreshed: member" : "Membership refreshed: not a member");
  }, [membershipFetcher.data, shopify]);

  const submitAdjust = () => adjustFetcher.submit({ intent: "adjust", delta, reason, idempotencyKey }, { method: "POST" });
  const submitRedeem = () =>
    redeemFetcher.submit({ intent: "redeem", points, channel, idempotencyKey: redeemKey }, { method: "POST" });
  const refreshMembership = () => membershipFetcher.submit({ intent: "membership" }, { method: "POST" });
  const busy = (f: { state: string }) => (f.state !== "idle" ? { loading: true } : {});

  const windowText = windows
    .filter((w) => w.active)
    .map(
      (w) =>
        `${w.label || "Window"}: ${WEEKDAY_NAMES[w.dayOfWeek]}${w.startHour !== null || w.endHour !== null ? ` ${w.startHour ?? 0}:00-${w.endHour ?? 24}:00` : ""} x${w.multiplier}${w.channels.length ? ` (${w.channels.join("/")})` : ""}${w.memberOnly ? ", members only" : ""}`,
    );

  return (
    <s-page heading={member.name}>
      <s-link slot="breadcrumb-actions" href="/app/loyalty">
        Loyalty members
      </s-link>

      {adjustData?.ok && adjustData.intent === "adjust" && adjustData.metafield === "queued" && (
        <s-banner tone="warning" heading="Points saved; customer metafield update queued">
          <s-paragraph>
            The ledger is updated. Writing borderline.points_balance to the customer failed and will be retried in the
            background.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Member">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="base">
            <s-text>Balance: {member.balance} pts</s-text>
            {member.pending !== 0 && <s-text>Pending: {member.pending} pts</s-text>}
            <s-badge tone={member.isMember ? "success" : "neutral"}>{member.isMember ? "paying member" : "not a member"}</s-badge>
            {member.paidUntil && <s-text>Renews {member.paidUntil}</s-text>}
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

      <s-section heading="Memberships">
        <ErrorList errors={membershipErrors} />
        <s-stack direction="block" gap="base">
          <s-text>
            Member tag: {member.hasTag ? "present" : "missing"} · Tags: {member.tags.length ? member.tags.join(", ") : "—"} ·
            Last synced: {member.membershipSyncedAt ?? "never"}
          </s-text>
          {memberships.length === 0 ? (
            <s-paragraph>No membership subscriptions recorded.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Plan</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Source</s-table-header>
                <s-table-header>Started</s-table-header>
                <s-table-header>Renews</s-table-header>
                <s-table-header>Contract</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {memberships.map((m) => (
                  <s-table-row key={m.id}>
                    <s-table-cell>{m.planName ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={m.status === "active" ? "success" : "neutral"}>{m.status}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{m.source}</s-table-cell>
                    <s-table-cell>{m.startedAt ?? "—"}</s-table-cell>
                    <s-table-cell>{m.endsAt ? `ends ${m.endsAt}` : (m.renewsAt ?? "—")}</s-table-cell>
                    <s-table-cell>{m.externalId ?? "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-button onClick={refreshMembership} {...busy(membershipFetcher)}>
            Refresh from Shopify
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Issue redemption">
        <ErrorList errors={redeemErrors} />
        {redeemData?.ok && redeemData.intent === "redeem" && (
          <s-banner tone="success" heading={`Discount code: ${redeemData.code}`}>
            <s-paragraph>
              {redeemData.amount} off, {redeemData.points} points, single use, only for this customer, expires {redeemData.expiresAt}{" "}
              (Toronto time). Online: the customer enters the code at checkout. POS (incl. NMK POS Lite): attach this customer to the
              cart and enter the code.
            </s-paragraph>
          </s-banner>
        )}
        {options.length === 0 ? (
          <s-paragraph>
            Needs at least {redeemRules.minRedeemPoints} points to redeem (balance {member.balance}).
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-select label="Points" name="points" value={points} onChange={(e: Event) => setPoints(fieldValue(e))}>
                {options.map((p) => (
                  <s-option key={p} value={String(p)}>
                    {p} pts
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="Channel"
                name="channel"
                value={channel}
                onChange={(e: Event) => setChannel(fieldValue(e) as RedeemChannel)}
              >
                <s-option value="pos">In store (POS)</s-option>
                <s-option value="web">Online</s-option>
              </s-select>
            </s-stack>
            {quote && (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <s-text>
                  {quote.ok
                    ? `${formatCents(quote.amountCents)} off before tax (worth ${formatCents(quote.faceValueCents)}${redeemRules.redeemAmountIsTaxInclusive ? ` incl. ${Math.round(redeemRules.assumedTaxRate * 100)}% tax` : ""})${quote.multiplier !== 1 ? ` · ${quote.window?.label ?? "redeem window"} x${quote.multiplier} applied` : ""}`
                    : quote.error}
                </s-text>
              </s-box>
            )}
            {windowText.length > 0 && <s-text>Redeem windows: {windowText.join("; ")}</s-text>}
            <s-button
              variant="primary"
              onClick={submitRedeem}
              {...(quote?.ok ? {} : { disabled: true })}
              {...busy(redeemFetcher)}
            >
              Issue code
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Adjust points">
        <ErrorList errors={adjustErrors} />
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
          <s-button variant="primary" onClick={submitAdjust} {...busy(adjustFetcher)}>
            Save adjustment
          </s-button>
        </s-stack>
      </s-section>

      {redemptions.length > 0 && (
        <s-section heading="Redemptions">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Code</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Points</s-table-header>
              <s-table-header format="numeric">Amount</s-table-header>
              <s-table-header>Channel</s-table-header>
              <s-table-header>Issued</s-table-header>
              <s-table-header>Expires (Toronto)</s-table-header>
              <s-table-header>By</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {redemptions.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{r.code ?? "—"}</s-table-cell>
                  <s-table-cell>{r.status}</s-table-cell>
                  <s-table-cell>{r.points}</s-table-cell>
                  <s-table-cell>{r.amount}</s-table-cell>
                  <s-table-cell>{r.channel}</s-table-cell>
                  <s-table-cell>{r.createdAt}</s-table-cell>
                  <s-table-cell>{r.expiresAt ?? "—"}</s-table-cell>
                  <s-table-cell>{r.issuedBy}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

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
