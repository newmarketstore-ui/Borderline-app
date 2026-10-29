// 客户详情页内嵌块：余额、会员档、最近流水。
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { getMember } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const customerId = shopify.customer?.id ?? null;
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!customerId) return;
    getMember(customerId).then(setSummary).catch((e) => setError(e.message));
  }, [customerId]);

  return (
    <s-section heading={i18n.translate("block_heading")}>
      {error && <s-banner tone="critical">{error}</s-banner>}
      {!summary && !error && <s-text>{i18n.translate("tile_loading")}</s-text>}
      {summary && (
        <s-stack direction="block" gap="small-200">
          <s-text>{i18n.translate("balance_line", { points: summary.balance })}</s-text>
          <s-text>
            {summary.isPaidMember
              ? i18n.translate("paid_member", { rate: summary.rules.paidPointsPerDollar })
              : i18n.translate("standard_member", { rate: summary.rules.pointsPerDollar, paid: summary.rules.paidPointsPerDollar })}
          </s-text>
          {summary.storeCredit !== null && <s-text>{i18n.translate("store_credit_line", { amount: summary.storeCredit })}</s-text>}
          {summary.recent.slice(0, 5).map((r, i) => (
            <s-text key={i} tone="subdued">
              {`${r.at.slice(0, 10)} · ${r.type} · ${r.delta > 0 ? "+" : ""}${r.delta}${r.orderName ? ` · ${r.orderName}` : ""}`}
            </s-text>
          ))}
          <s-text tone="subdued">{i18n.translate("block_hint")}</s-text>
        </s-stack>
      )}
    </s-section>
  );
}
