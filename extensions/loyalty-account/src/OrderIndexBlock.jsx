// 订单列表页顶部小卡：余额 + 去 Rewards 页
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { getMe } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [me, setMe] = useState(null);
  useEffect(() => {
    getMe().then(setMe).catch(() => setMe(null));
  }, []);
  if (!me) return null;
  return (
    <s-banner heading={i18n.translate("card_heading", { points: me.balance })}>
      <s-stack direction="block" gap="small-200">
        <s-text>
          {me.isPaidMember
            ? i18n.translate("paid_member", { rate: me.rules.paidPointsPerDollar })
            : i18n.translate("standard_member", { rate: me.rules.pointsPerDollar, paid: me.rules.paidPointsPerDollar })}
        </s-text>
        <s-link href="extension:/">{i18n.translate("card_link")}</s-link>
      </s-stack>
    </s-banner>
  );
}
