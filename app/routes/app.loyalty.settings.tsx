import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getLoyaltySettings, parseSettingsForm, saveLoyaltySettings, staffIdentity } from "../models/loyalty.server";

// 积分规则（LoyaltyConfig，每店一行）。默认值只是占位，正式数字等老板拍板。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { settings: await getLoyaltySettings(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const parsed = parseSettingsForm(await request.formData());
  if (!parsed.ok) return { ok: false as const, errors: parsed.errors };
  await saveLoyaltySettings(session.shop, parsed.value, staffIdentity(session, sessionToken));
  return { ok: true as const };
};

type Settings = Awaited<ReturnType<typeof loader>>["settings"];

function toForm(s: Settings) {
  return {
    pointsPerDollar: String(s.pointsPerDollar),
    redeemPointsPerDollar: String(s.redeemPointsPerDollar),
    minRedeemPoints: String(s.minRedeemPoints),
    redeemStepPoints: String(s.redeemStepPoints),
    excludedProductTypes: s.excludedProductTypes.join(", "),
    excludedTags: s.excludedTags.join(", "),
    earnOnShipping: s.earnOnShipping,
    earnOnTax: s.earnOnTax,
    pendingDays: String(s.pendingDays),
    expiryMonths: s.expiryMonths === null ? "" : String(s.expiryMonths),
    paidTierMultiplier: String(s.paidTierMultiplier),
  };
}

type FormState = ReturnType<typeof toForm>;
type TextKey = { [K in keyof FormState]: FormState[K] extends string ? K : never }[keyof FormState];

const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const fieldChecked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

export default function LoyaltySettingsPage() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [form, setForm] = useState(() => toForm(settings));

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Loyalty settings saved");
  }, [fetcher.data, shopify]);

  const saving = fetcher.state !== "idle";
  const errors = fetcher.data && !fetcher.data.ok ? fetcher.data.errors : [];
  const set = (key: TextKey) => (e: Event) => setForm((f) => ({ ...f, [key]: fieldValue(e) }));

  const save = () =>
    fetcher.submit(
      {
        ...form,
        earnOnShipping: form.earnOnShipping ? "true" : "false",
        earnOnTax: form.earnOnTax ? "true" : "false",
      },
      { method: "POST" },
    );

  return (
    <s-page heading="Loyalty settings">
      <s-link slot="breadcrumb-actions" href="/app/loyalty">
        Loyalty members
      </s-link>
      <s-button slot="primary-action" variant="primary" onClick={save} {...(saving ? { loading: true } : {})}>
        Save
      </s-button>

      {!settings.persisted && (
        <s-banner tone="info" heading="Using placeholder defaults">
          <s-paragraph>
            Nothing has been saved for this store yet. The values below are placeholders until the owner confirms the
            real earn / redeem rules. Changes apply to orders paid after saving; past ledger entries are not recalculated.
          </s-paragraph>
        </s-banner>
      )}
      {settings.persisted && settings.updatedBy && (
        <s-banner tone="info" heading={`Last saved by ${settings.updatedBy} on ${settings.updatedAt?.slice(0, 10)}`} />
      )}

      {errors.length > 0 && (
        <s-banner tone="critical" heading="Please fix and try again">
          <s-unordered-list>
            {errors.map((e: string) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <s-section heading="Earning">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Points per $1 spent"
            name="pointsPerDollar"
            min={0}
            step={0.01}
            value={form.pointsPerDollar}
            onInput={set("pointsPerDollar")}
          />
          <s-number-field
            label="Paid member multiplier"
            details="Points are multiplied by this for members with tier = paid (1 = no bonus)"
            name="paidTierMultiplier"
            min={0}
            step={0.05}
            value={form.paidTierMultiplier}
            onInput={set("paidTierMultiplier")}
          />
          <s-text-area
            label="Excluded product types"
            details="Comma or line separated, case-insensitive. Gift cards never earn points."
            name="excludedProductTypes"
            rows={2}
            value={form.excludedProductTypes}
            onInput={set("excludedProductTypes")}
          />
          <s-text-area
            label="Excluded product tags"
            details="Comma or line separated, case-insensitive"
            name="excludedTags"
            rows={2}
            value={form.excludedTags}
            onInput={set("excludedTags")}
          />
          <s-checkbox
            label="Earn points on shipping"
            name="earnOnShipping"
            checked={form.earnOnShipping}
            onChange={(e: Event) => setForm((f) => ({ ...f, earnOnShipping: fieldChecked(e) }))}
          />
          <s-checkbox
            label="Earn points on tax"
            name="earnOnTax"
            checked={form.earnOnTax}
            onChange={(e: Event) => setForm((f) => ({ ...f, earnOnTax: fieldChecked(e) }))}
          />
          <s-number-field
            label="Pending days before points become usable"
            details="0 = points are usable immediately; refunds reverse them proportionally either way"
            name="pendingDays"
            min={0}
            step={1}
            value={form.pendingDays}
            onInput={set("pendingDays")}
          />
          <s-number-field
            label="Points expire after (months)"
            details="Leave empty for no expiry (expiry job not built yet)"
            name="expiryMonths"
            min={1}
            step={1}
            value={form.expiryMonths}
            onInput={set("expiryMonths")}
          />
        </s-stack>
      </s-section>

      <s-section heading="Redeeming">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Points per $1 of discount"
            name="redeemPointsPerDollar"
            min={1}
            step={1}
            value={form.redeemPointsPerDollar}
            onInput={set("redeemPointsPerDollar")}
          />
          <s-number-field
            label="Minimum points per redemption"
            name="minRedeemPoints"
            min={0}
            step={1}
            value={form.minRedeemPoints}
            onInput={set("minRedeemPoints")}
          />
          <s-number-field
            label="Redeem in steps of (points)"
            name="redeemStepPoints"
            min={1}
            step={1}
            value={form.redeemStepPoints}
            onInput={set("redeemStepPoints")}
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
