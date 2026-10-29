import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  getLoyaltySettings,
  getRedeemWindows,
  parseSettingsForm,
  parseWindowsJson,
  saveLoyaltySettings,
  saveRedeemWindows,
  staffIdentity,
} from "../models/loyalty.server";
import { formatCents, redeemAmountCents, REDEEM_ROUNDINGS, WEEKDAY_NAMES, type RedeemRounding } from "../lib/redeemMath";

// 积分规则（LoyaltyConfig，每店一行）+ 兑换倍数窗口（RedeemWindow）。默认值 = Appstle 现行规则。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltySettings(session.shop);
  return { settings, windows: await getRedeemWindows(session.shop, settings) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseSettingsForm(form);
  const windows = parseWindowsJson(String(form.get("windows") ?? "[]"));
  const errors = [...(parsed.ok ? [] : parsed.errors), ...(windows.ok ? [] : windows.errors)];
  if (!parsed.ok || !windows.ok) return { ok: false as const, errors };
  await saveLoyaltySettings(session.shop, parsed.value, staffIdentity(session, sessionToken));
  await saveRedeemWindows(session.shop, windows.value);
  return { ok: true as const };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Settings = LoaderData["settings"];

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
    expiryMode: s.expiryMode as string,
    paidTierMultiplier: String(s.paidTierMultiplier),
    earnRequiresMember: s.earnRequiresMember,
    memberTag: s.memberTag,
    membershipProductTag: s.membershipProductTag,
    membershipMonths: String(s.membershipMonths),
    excludeDiscountedItems: s.excludeDiscountedItems,
    redeemMethod: s.redeemMethod as string,
    storeCreditExpiryMonths: s.storeCreditExpiryMonths === null ? "" : String(s.storeCreditExpiryMonths),
    signupBonusPoints: String(s.signupBonusPoints),
    migrationPointsMultiplier: String(s.migrationPointsMultiplier),
    posAllowStoreCredit: s.posAllowStoreCredit,
    posAllowCartDiscount: s.posAllowCartDiscount,
    cartDiscountExpiryMinutes: String(s.cartDiscountExpiryMinutes),
    redeemAmountIsTaxInclusive: s.redeemAmountIsTaxInclusive,
    assumedTaxRate: String(s.assumedTaxRate),
    redeemRounding: s.redeemRounding as string,
    redeemRequiresMember: s.redeemRequiresMember,
    redeemCodePrefix: s.redeemCodePrefix,
    redeemExpiryHours: String(s.redeemExpiryHours),
  };
}

type FormState = ReturnType<typeof toForm>;
type TextKey = { [K in keyof FormState]: FormState[K] extends string ? K : never }[keyof FormState];
type BoolKey = { [K in keyof FormState]: FormState[K] extends boolean ? K : never }[keyof FormState];

type WindowForm = {
  label: string;
  dayOfWeek: string;
  startHour: string;
  endHour: string;
  timezone: string;
  multiplier: string;
  pos: boolean;
  web: boolean;
  memberOnly: boolean;
  active: boolean;
  minSpendEqualsDiscount: boolean;
};

const toWindowForm = (w: LoaderData["windows"][number]): WindowForm => ({
  label: w.label ?? "",
  dayOfWeek: String(w.dayOfWeek),
  startHour: w.startHour === null ? "" : String(w.startHour),
  endHour: w.endHour === null ? "" : String(w.endHour),
  timezone: w.timezone,
  multiplier: String(w.multiplier),
  pos: w.channels.length === 0 || w.channels.includes("pos"),
  web: w.channels.length === 0 || w.channels.includes("web"),
  memberOnly: w.memberOnly,
  active: w.active,
  minSpendEqualsDiscount: Boolean(w.minSpendEqualsDiscount),
});

const NEW_WINDOW: WindowForm = {
  label: "",
  dayOfWeek: "3",
  startHour: "",
  endHour: "",
  timezone: "America/Toronto",
  multiplier: "2",
  pos: true,
  web: false,
  memberOnly: true,
  active: true,
  minSpendEqualsDiscount: false,
};

const ROUNDING_LABELS: Record<RedeemRounding, string> = {
  nearest_cent: "Nearest cent (500 pts → $44.25)",
  floor_cent: "Round down to the cent ($44.24)",
  up_10_cents: "Round up to 10 cents ($44.30, matches Appstle)",
};

const fieldValue = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const fieldChecked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

export default function LoyaltySettingsPage() {
  const { settings, windows } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [form, setForm] = useState(() => toForm(settings));
  const [wins, setWins] = useState<WindowForm[]>(() => windows.map(toWindowForm));

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Loyalty settings saved");
  }, [fetcher.data, shopify]);

  const saving = fetcher.state !== "idle";
  const errors = fetcher.data && !fetcher.data.ok ? fetcher.data.errors : [];
  const set = (key: TextKey) => (e: Event) => setForm((f) => ({ ...f, [key]: fieldValue(e) }));
  const setBool = (key: BoolKey) => (e: Event) => setForm((f) => ({ ...f, [key]: fieldChecked(e) }));
  const setWin = (i: number, patch: Partial<WindowForm>) =>
    setWins((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  const example = (() => {
    const r = {
      redeemMethod: form.redeemMethod as "store_credit" | "discount_code",
      redeemPointsPerDollar: Number(form.redeemPointsPerDollar) || 0,
      redeemAmountIsTaxInclusive: form.redeemAmountIsTaxInclusive,
      assumedTaxRate: Number(form.assumedTaxRate) || 0,
      redeemRounding: form.redeemRounding as RedeemRounding,
    };
    const pts = Number(form.minRedeemPoints) || 1000;
    const what = form.redeemMethod === "store_credit" ? "store credit" : "off before tax";
    return `${pts} pts → ${formatCents(redeemAmountCents(pts, 1, r).amountCents)} ${what}; with x2 → ${formatCents(redeemAmountCents(pts, 2, r).amountCents)}`;
  })();

  const save = () => {
    const bools = Object.fromEntries(
      (
        [
          "earnOnShipping",
          "earnOnTax",
          "earnRequiresMember",
          "excludeDiscountedItems",
          "redeemAmountIsTaxInclusive",
          "redeemRequiresMember",
          "posAllowStoreCredit",
          "posAllowCartDiscount",
        ] as BoolKey[]
      ).map((k) => [k, form[k] ? "true" : "false"]),
    );
    fetcher.submit(
      {
        ...form,
        ...bools,
        windows: JSON.stringify(
          wins.map((w) => ({
            label: w.label,
            dayOfWeek: Number(w.dayOfWeek),
            startHour: w.startHour,
            endHour: w.endHour,
            timezone: w.timezone,
            multiplier: Number(w.multiplier),
            channels: w.pos && w.web ? [] : [w.pos ? "pos" : null, w.web ? "web" : null].filter(Boolean),
            memberOnly: w.memberOnly,
            active: w.active,
            minSpendEqualsDiscount: w.minSpendEqualsDiscount,
          })),
        ),
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Loyalty settings">
      <s-link slot="breadcrumb-actions" href="/app/loyalty">
        Loyalty members
      </s-link>
      <s-button slot="primary-action" variant="primary" onClick={save} {...(saving ? { loading: true } : {})}>
        Save
      </s-button>

      {!settings.persisted && (
        <s-banner tone="info" heading="Showing the owner's 2026-10-29 rules as defaults">
          <s-paragraph>
            Nothing has been saved for this store yet. Defaults: every customer with a profile earns 1 pt per $1, paid
            members earn 10 pts per $1, 1000 pts = $10 store credit, Appstle balances are imported at x10. Changes apply to
            orders paid after saving; past ledger entries are not recalculated.
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

      <s-section heading="Membership">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Only paying members earn points"
            details="Member = customer tag below, or an active membership subscription (Appstle Memberships)"
            checked={form.earnRequiresMember}
            onChange={setBool("earnRequiresMember")}
          />
          <s-checkbox
            label="Only paying members can redeem points"
            checked={form.redeemRequiresMember}
            onChange={setBool("redeemRequiresMember")}
          />
          <s-text-field label="Member customer tag" name="memberTag" value={form.memberTag} onInput={set("memberTag")} />
        </s-stack>
      </s-section>

      <s-section heading="Earning">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Points per $1 spent"
            details="Line subtotal; tax and shipping only if ticked below"
            name="pointsPerDollar"
            min={0}
            step={0.01}
            value={form.pointsPerDollar}
            onInput={set("pointsPerDollar")}
          />
          <s-checkbox
            label="Discounted items earn no points"
            details="Any line with a discount allocation (including points codes) is skipped"
            checked={form.excludeDiscountedItems}
            onChange={setBool("excludeDiscountedItems")}
          />
          <s-number-field
            label="Paid member multiplier"
            details="Paid members earn points x this (10 = 10 pts per $1). Paid = Appstle member tag/contract or a purchase of the membership product below."
            name="paidTierMultiplier"
            min={0}
            step={0.05}
            value={form.paidTierMultiplier}
            onInput={set("paidTierMultiplier")}
          />
          <s-text-field
            label="Membership product tag"
            details="Buying a product with this tag grants paid membership (the order itself earns at the paid rate)"
            name="membershipProductTag"
            value={form.membershipProductTag}
            onInput={set("membershipProductTag")}
          />
          <s-number-field
            label="Membership length (months)"
            name="membershipMonths"
            min={1}
            step={1}
            value={form.membershipMonths}
            onInput={set("membershipMonths")}
          />
          <s-number-field
            label="Welcome bonus points"
            details="Granted once when a customer is first seen (0 = off)"
            name="signupBonusPoints"
            min={0}
            step={1}
            value={form.signupBonusPoints}
            onInput={set("signupBonusPoints")}
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
          <s-checkbox label="Earn points on shipping" checked={form.earnOnShipping} onChange={setBool("earnOnShipping")} />
          <s-checkbox label="Earn points on tax" checked={form.earnOnTax} onChange={setBool("earnOnTax")} />
          <s-number-field
            label="Pending days before points become usable"
            details="0 = points are usable immediately; refunds reverse them proportionally either way"
            name="pendingDays"
            min={0}
            step={1}
            value={form.pendingDays}
            onInput={set("pendingDays")}
          />
          <s-select label="Points expiry" name="expiryMode" value={form.expiryMode} onChange={set("expiryMode")}>
            <s-option value="off">Never expire</s-option>
            <s-option value="inactivity">Expire after N months without any earn or redeem</s-option>
          </s-select>
          <s-number-field
            label="Expiry months (inactivity)"
            details="Checked daily; the whole balance is zeroed with an 'expire' ledger line"
            name="expiryMonths"
            min={1}
            step={1}
            value={form.expiryMonths}
            onInput={set("expiryMonths")}
          />
          <s-number-field
            label="Appstle import multiplier"
            details="Appstle used 10 pts = $1; ours is 100 pts = $1, so old balances import at x10 to keep their value"
            name="migrationPointsMultiplier"
            min={0}
            step={0.5}
            value={form.migrationPointsMultiplier}
            onInput={set("migrationPointsMultiplier")}
          />
        </s-stack>
      </s-section>

      <s-section heading="Redeeming">
        <s-stack direction="block" gap="base">
          <s-select label="Redeem as" name="redeemMethod" value={form.redeemMethod} onChange={set("redeemMethod")}>
            <s-option value="store_credit">Shopify store credit (works at online checkout and POS, no code)</s-option>
            <s-option value="discount_code">Single-use discount code</s-option>
          </s-select>
          <s-number-field
            label="Store credit expires after (months)"
            details="Empty = never expires. Only used when redeeming as store credit."
            name="storeCreditExpiryMonths"
            min={1}
            step={1}
            value={form.storeCreditExpiryMonths}
            onInput={set("storeCreditExpiryMonths")}
          />
          <s-number-field
            label="Points per $1 of value"
            name="redeemPointsPerDollar"
            min={1}
            step={1}
            value={form.redeemPointsPerDollar}
            onInput={set("redeemPointsPerDollar")}
          />
          <s-checkbox
            label="The $ value is tax-inclusive (discount codes only)"
            details="Canada taxes after discounts, so the pre-tax discount = value / (1 + tax rate). Store credit pays the taxed total directly."
            checked={form.redeemAmountIsTaxInclusive}
            onChange={setBool("redeemAmountIsTaxInclusive")}
          />
          <s-number-field
            label="Assumed tax rate"
            details="0.13 = Ontario HST"
            name="assumedTaxRate"
            min={0}
            max={0.5}
            step={0.0001}
            value={form.assumedTaxRate}
            onInput={set("assumedTaxRate")}
          />
          <s-select label="Rounding" name="redeemRounding" value={form.redeemRounding} onChange={set("redeemRounding")}>
            {REDEEM_ROUNDINGS.map((r) => (
              <s-option key={r} value={r}>
                {ROUNDING_LABELS[r]}
              </s-option>
            ))}
          </s-select>
          <s-text>Example: {example}</s-text>
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
          <s-text-field
            label="Discount code prefix (discount codes only)"
            name="redeemCodePrefix"
            value={form.redeemCodePrefix}
            onInput={set("redeemCodePrefix")}
          />
          <s-number-field
            label="Codes expire after (hours, discount codes only)"
            name="redeemExpiryHours"
            min={1}
            step={1}
            value={form.redeemExpiryHours}
            onInput={set("redeemExpiryHours")}
          />
        </s-stack>
      </s-section>

      <s-section heading="POS (in-store) redeem options">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Convert points to store credit"
            details="One tap in the POS tile; staff then takes payment with Store credit. Credit stays on the customer's account."
            checked={form.posAllowStoreCredit}
            onChange={setBool("posAllowStoreCredit")}
          />
          <s-checkbox
            label="Apply points to the current cart"
            details="One tap applies a fixed-amount discount to this cart (no code). Points come back automatically if the sale is not completed."
            checked={form.posAllowCartDiscount}
            onChange={setBool("posAllowCartDiscount")}
          />
          <s-number-field
            label="Cart discount hold (minutes)"
            details="If no paid order uses the discount within this time, the points are returned"
            name="cartDiscountExpiryMinutes"
            min={5}
            step={5}
            value={form.cartDiscountExpiryMinutes}
            onInput={set("cartDiscountExpiryMinutes")}
          />
        </s-stack>
      </s-section>

      <s-section heading="Redeem windows">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Multiply the redemption value during these local-time windows (Appstle: Double Redeem Every Wednesday, POS only,
            members only). Leave both hours empty for the whole day; the end hour is exclusive.
          </s-paragraph>
          {wins.length === 0 && <s-paragraph>No windows: every redemption uses x1.</s-paragraph>}
          {wins.map((w, i) => (
            <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="base">
                  <s-text-field label="Label" value={w.label} onInput={(e: Event) => setWin(i, { label: fieldValue(e) })} />
                  <s-select label="Day" value={w.dayOfWeek} onChange={(e: Event) => setWin(i, { dayOfWeek: fieldValue(e) })}>
                    {WEEKDAY_NAMES.map((d, n) => (
                      <s-option key={d} value={String(n)}>
                        {d}
                      </s-option>
                    ))}
                  </s-select>
                  <s-number-field
                    label="Multiplier"
                    min={0}
                    step={0.5}
                    value={w.multiplier}
                    onInput={(e: Event) => setWin(i, { multiplier: fieldValue(e) })}
                  />
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Start hour (0-23)"
                    min={0}
                    max={23}
                    step={1}
                    value={w.startHour}
                    onInput={(e: Event) => setWin(i, { startHour: fieldValue(e) })}
                  />
                  <s-number-field
                    label="End hour (1-24)"
                    min={1}
                    max={24}
                    step={1}
                    value={w.endHour}
                    onInput={(e: Event) => setWin(i, { endHour: fieldValue(e) })}
                  />
                  <s-text-field label="Time zone" value={w.timezone} onInput={(e: Event) => setWin(i, { timezone: fieldValue(e) })} />
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-checkbox label="POS" checked={w.pos} onChange={(e: Event) => setWin(i, { pos: fieldChecked(e) })} />
                  <s-checkbox label="Online" checked={w.web} onChange={(e: Event) => setWin(i, { web: fieldChecked(e) })} />
                  <s-checkbox
                    label="Members only"
                    checked={w.memberOnly}
                    onChange={(e: Event) => setWin(i, { memberOnly: fieldChecked(e) })}
                  />
                  <s-checkbox
                    label="Min. order = discount"
                    checked={w.minSpendEqualsDiscount}
                    onChange={(e: Event) => setWin(i, { minSpendEqualsDiscount: fieldChecked(e) })}
                  />
                  <s-checkbox label="Active" checked={w.active} onChange={(e: Event) => setWin(i, { active: fieldChecked(e) })} />
                  <s-button tone="critical" onClick={() => setWins((ws) => ws.filter((_, j) => j !== i))}>
                    Remove
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          ))}
          <s-button onClick={() => setWins((ws) => [...ws, { ...NEW_WINDOW }])}>Add window</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
