// 兑换弹窗：选档位 → 一键换成 Store Credit（收款时选 Store credit），或规则为折扣码时直接把码套进购物车。
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { getMember, money, newKey, redeem } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const customerId = shopify.cart.current.value?.customer?.id ?? null;
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [selected, setSelected] = useState(null);
  const key = useMemo(() => newKey(), []);

  const load = async () => {
    if (!customerId) return;
    try {
      const s = await getMember(customerId);
      setSummary(s);
      setSelected((cur) => cur ?? s.options[0]?.points ?? null);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [customerId]);

  const submit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await redeem(customerId, selected, key);
      if (r.method === "discount_code" && r.code) {
        await shopify.cart.applyCartCodeDiscount(r.code);
      }
      setDone(r);
      shopify.toast.show(r.method === "store_credit" ? i18n.translate("toast_store_credit", { amount: r.amount }) : i18n.translate("toast_code", { code: r.code }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
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
                  {summary.options.length === 0 ? (
                    <s-text>{i18n.translate("need_more", { min: summary.rules.minRedeemPoints })}</s-text>
                  ) : (
                    <s-stack direction="block" gap="small-200">
                      {summary.options.map((o) => (
                        <s-button
                          key={o.points}
                          variant={selected === o.points ? "primary" : "secondary"}
                          onClick={() => setSelected(o.points)}
                        >
                          {`${o.points} pts → ${o.amount}${o.multiplier !== 1 ? ` (${o.windowLabel || "x" + o.multiplier})` : ""}`}
                        </s-button>
                      ))}
                      <s-button variant="primary" disabled={!selected || busy} loading={busy} onClick={submit}>
                        {summary.rules.redeemMethod === "store_credit"
                          ? i18n.translate("redeem_store_credit", { points: selected ?? 0 })
                          : i18n.translate("redeem_code", { points: selected ?? 0 })}
                      </s-button>
                      <s-text tone="subdued">
                        {summary.rules.redeemMethod === "store_credit" ? i18n.translate("hint_store_credit") : i18n.translate("hint_code")}
                      </s-text>
                    </s-stack>
                  )}
                </s-section>

                {done && (
                  <s-banner tone="success">
                    {done.method === "store_credit"
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

// money 导出保留给其它模块
export { money };
