// 顾客账户 → Rewards 全页
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { getMe, newKey, redeem } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [selected, setSelected] = useState(null);
  const [key, setKey] = useState(() => newKey());

  const load = () =>
    getMe()
      .then((m) => {
        setMe(m);
        setSelected((cur) => cur ?? m.options[0]?.points ?? null);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await redeem(selected, key);
      setDone(r);
      setKey(newKey());
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const paidRate = me?.rules?.paidPointsPerDollar;
  const stdRate = me?.rules?.pointsPerDollar;
  const valuePer1000 = useMemo(() => (me ? `$${(1000 / me.rules.redeemPointsPerDollar).toFixed(0)}` : ""), [me]);

  return (
    <s-page heading={i18n.translate("page_heading")}>
      <s-stack direction="block" gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}
        {!me && !error && <s-text>{i18n.translate("loading")}</s-text>}
        {me && (
          <>
            <s-section heading={i18n.translate("balance_heading")}>
              <s-stack direction="block" gap="small-200">
                <s-heading>{i18n.translate("balance_points", { points: me.balance })}</s-heading>
                {me.pending > 0 && <s-text tone="subdued">{i18n.translate("pending_points", { points: me.pending })}</s-text>}
                <s-text>
                  {me.isPaidMember
                    ? i18n.translate("paid_member", { rate: paidRate })
                    : i18n.translate("standard_member", { rate: stdRate, paid: paidRate })}
                </s-text>
                {me.storeCredit !== null && <s-text>{i18n.translate("store_credit_line", { amount: me.storeCredit })}</s-text>}
                <s-text tone="subdued">{i18n.translate("how_it_works", { min: me.rules.minRedeemPoints, value: valuePer1000 })}</s-text>
              </s-stack>
            </s-section>

            <s-section heading={i18n.translate("redeem_heading")}>
              {me.options.length === 0 ? (
                <s-text>{i18n.translate("need_more", { min: me.rules.minRedeemPoints, balance: me.balance })}</s-text>
              ) : (
                <s-stack direction="block" gap="small-200">
                  <s-choice-list
                    name="points"
                    value={selected ? String(selected) : undefined}
                    onChange={(e) => setSelected(Number(e.currentTarget?.value ?? e.target?.value))}
                  >
                    {me.options.map((o) => (
                      <s-choice key={o.points} value={String(o.points)}>
                        {`${o.points} pts → ${o.amount}${o.multiplier !== 1 ? ` (${o.windowLabel || "x" + o.multiplier})` : ""}`}
                      </s-choice>
                    ))}
                  </s-choice-list>
                  <s-button variant="primary" disabled={!selected || busy} loading={busy} onClick={submit}>
                    {me.rules.redeemMethod === "store_credit"
                      ? i18n.translate("redeem_store_credit", { points: selected ?? 0 })
                      : i18n.translate("redeem_code", { points: selected ?? 0 })}
                  </s-button>
                  <s-text tone="subdued">
                    {me.rules.redeemMethod === "store_credit" ? i18n.translate("hint_store_credit") : i18n.translate("hint_code")}
                  </s-text>
                </s-stack>
              )}
              {done && (
                <s-banner tone="success">
                  {done.method === "store_credit"
                    ? i18n.translate("done_store_credit", { amount: done.amount })
                    : i18n.translate("done_code", { code: done.code, amount: done.amount })}
                </s-banner>
              )}
            </s-section>

            <s-section heading={i18n.translate("history_heading")}>
              {me.recent.length === 0 ? (
                <s-text tone="subdued">{i18n.translate("history_empty")}</s-text>
              ) : (
                <s-stack direction="block" gap="small-100">
                  {me.recent.map((r, i) => (
                    <s-text key={i}>
                      {`${r.at.slice(0, 10)} · ${label(r.type, i18n)} · ${r.delta > 0 ? "+" : ""}${r.delta}${r.orderName ? ` · ${r.orderName}` : ""}`}
                    </s-text>
                  ))}
                </s-stack>
              )}
            </s-section>
          </>
        )}
      </s-stack>
    </s-page>
  );
}

function label(type, i18n) {
  const key = `type_${type}`;
  const t = i18n.translate(key);
  return t && t !== key ? t : type;
}
