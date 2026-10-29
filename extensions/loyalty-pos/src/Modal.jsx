// 兑换弹窗（老板 10/29）：两种一键方式，后台 Loyalty settings 可分别开关
//   1. 换成 Store Credit：积分 → 顾客账户余额，收款时选 Store credit
//   2. 抵扣当前购物车：积分 → 这张购物车的固定金额折扣（无码），没成交会自动退分
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { getMember, newKey, redeem, release, toCents } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const cart = shopify.cart.current.value;
  const customerId = cart?.customer?.id ?? null;
  const subtotalCents = toCents(cart?.subtotal);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "store_credit" | "cart_discount" | null
  const [done, setDone] = useState(null);
  const [selected, setSelected] = useState(null);
  const [keys, setKeys] = useState(() => ({ store_credit: newKey(), cart_discount: newKey() }));

  const load = async () => {
    if (!customerId) return;
    try {
      const s = await getMember(customerId);
      setSummary(s);
      setSelected((cur) => cur ?? s.options[0]?.points ?? s.cartOptions[0]?.points ?? null);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [customerId]);

  // 抵扣档位：金额不能超过购物车小计
  const cartOptions = useMemo(
    () => (summary ? summary.cartOptions.filter((o) => o.amountCents <= subtotalCents) : []),
    [summary, subtotalCents],
  );
  const storeOption = summary?.options.find((o) => o.points === selected) ?? null;
  const cartOption = cartOptions.find((o) => o.points === selected) ?? null;
  const allOptions = summary ? (summary.pos.allowStoreCredit ? summary.options : cartOptions) : [];

  const run = async (mode) => {
    if (!selected || busy) return;
    setBusy(mode);
    setError(null);
    try {
      const r = await redeem(customerId, selected, keys[mode], mode, mode === "cart_discount" ? subtotalCents : undefined);
      if (mode === "cart_discount") {
        try {
          // 固定金额自定义折扣；标题 = 后端给的码，订单上靠它核销
          await shopify.cart.applyCartDiscount("FixedAmount", r.code, (r.amountCents / 100).toFixed(2));
        } catch (applyErr) {
          await release(r.redemptionId).catch(() => undefined);
          throw new Error(i18n.translate("apply_failed", { reason: applyErr?.message || "" }));
        }
      } else if (r.method === "discount_code" && r.code) {
        await shopify.cart.applyCartCodeDiscount(r.code);
      }
      setDone({ ...r, mode });
      setKeys((k) => ({ ...k, [mode]: newKey() }));
      shopify.toast.show(
        mode === "cart_discount"
          ? i18n.translate("toast_cart", { amount: r.amount })
          : r.method === "store_credit"
            ? i18n.translate("toast_store_credit", { amount: r.amount })
            : i18n.translate("toast_code", { code: r.code }),
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!customerId) {
    return (
      <s-page heading={i18n.translate("modal_heading")}>
        <s-box padding="base">
          <s-text>{i18n.translate("modal_no_customer")}</s-text>
        </s-box>
      </s-page>
    );
  }

  return (
    <s-page heading={i18n.translate("modal_heading")}>
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {error && <s-banner tone="critical">{error}</s-banner>}
            {!summary && !error && <s-text>{i18n.translate("tile_loading")}</s-text>}
            {summary && (
              <>
                <s-section heading={summary.name}>
                  <s-stack direction="block" gap="small-200">
                    <s-text>
                      {i18n.translate("balance_line", { points: summary.balance })}
                      {summary.pending > 0 ? ` (+${summary.pending} pending)` : ""}
                    </s-text>
                    <s-text>
                      {summary.isPaidMember
                        ? i18n.translate("paid_member", { rate: summary.rules.paidPointsPerDollar })
                        : i18n.translate("standard_member", { rate: summary.rules.pointsPerDollar, paid: summary.rules.paidPointsPerDollar })}
                    </s-text>
                    {summary.storeCredit !== null && <s-text>{i18n.translate("store_credit_line", { amount: summary.storeCredit })}</s-text>}
                  </s-stack>
                </s-section>

                <s-section heading={i18n.translate("redeem_heading")}>
                  {allOptions.length === 0 ? (
                    <s-text>{i18n.translate("need_more", { min: summary.rules.minRedeemPoints })}</s-text>
                  ) : (
                    <s-stack direction="block" gap="small-200">
                      <s-text tone="subdued">{i18n.translate("pick_points")}</s-text>
                      <s-stack direction="inline" gap="small-200">
                        {allOptions.map((o) => (
                          <s-button key={o.points} variant={selected === o.points ? "primary" : "secondary"} onClick={() => setSelected(o.points)}>
                            {`${o.points} pts`}
                          </s-button>
                        ))}
                      </s-stack>

                      {summary.pos.allowStoreCredit && (
                        <s-button variant="primary" disabled={!storeOption || Boolean(busy)} loading={busy === "store_credit"} onClick={() => run("store_credit")}>
                          {storeOption
                            ? i18n.translate("btn_store_credit", { amount: storeOption.amount, points: storeOption.points })
                            : i18n.translate("btn_store_credit_na")}
                        </s-button>
                      )}
                      {summary.pos.allowCartDiscount && (
                        <s-button variant={summary.pos.allowStoreCredit ? "secondary" : "primary"} disabled={!cartOption || Boolean(busy)} loading={busy === "cart_discount"} onClick={() => run("cart_discount")}>
                          {cartOption
                            ? i18n.translate("btn_cart", { amount: cartOption.amount, points: cartOption.points })
                            : i18n.translate("btn_cart_na", { subtotal: (subtotalCents / 100).toFixed(2) })}
                        </s-button>
                      )}
                      <s-text tone="subdued">
                        {[
                          summary.pos.allowStoreCredit ? i18n.translate("hint_store_credit") : null,
                          summary.pos.allowCartDiscount ? i18n.translate("hint_cart", { minutes: summary.pos.cartDiscountExpiryMinutes }) : null,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </s-text>
                    </s-stack>
                  )}
                </s-section>

                {done && (
                  <s-banner tone="success">
                    {done.mode === "cart_discount"
                      ? i18n.translate("done_cart", { amount: done.amount })
                      : done.method === "store_credit"
                        ? i18n.translate("done_store_credit", { amount: done.amount })
                        : i18n.translate("done_code", { code: done.code, amount: done.amount })}
                  </s-banner>
                )}

                {summary.recent.length > 0 && (
                  <s-section heading={i18n.translate("recent_heading")}>
                    <s-stack direction="block" gap="small-100">
                      {summary.recent.slice(0, 5).map((r, i) => (
                        <s-text key={i}>
                          {`${r.at.slice(0, 10)} · ${r.type} · ${r.delta > 0 ? "+" : ""}${r.delta}${r.orderName ? ` · ${r.orderName}` : ""}`}
                        </s-text>
                      ))}
                    </s-stack>
                  </s-section>
                )}
              </>
            )}
            <s-button variant="secondary" onClick={() => shopify.action.dismissModal && shopify.action.dismissModal()}>
              {i18n.translate("close")}
            </s-button>
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}
