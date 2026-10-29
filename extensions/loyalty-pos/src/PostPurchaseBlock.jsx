// 收尾屏内嵌块：这单赚了多少分、余额多少。后端当场记账（不等 webhook），秒到账。
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { orderEarned } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const order = shopify.order;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!order?.id) return;
    // 订单刚建好，Admin API 偶尔要 1–2 秒才能查到：失败就重试两次
    let attempt = 0;
    const run = () =>
      orderEarned(order.id)
        .then(setData)
        .catch((e) => {
          if (attempt++ < 2) setTimeout(run, 1500);
          else setError(e.message);
        });
    run();
  }, [order?.id]);

  if (!order?.customerId) {
    return (
      <s-section heading={i18n.translate("post_heading")}>
        <s-text tone="subdued">{i18n.translate("post_no_customer")}</s-text>
      </s-section>
    );
  }
  return (
    <s-section heading={i18n.translate("post_heading")}>
      {error && <s-banner tone="critical">{error}</s-banner>}
      {!data && !error && <s-text>{i18n.translate("tile_loading")}</s-text>}
      {data && data.earned > 0 && (
        <s-stack direction="block" gap="small-200">
          <s-text>{i18n.translate("post_earned", { points: data.earned, name: order.name })}</s-text>
          <s-text>{i18n.translate("post_balance", { points: data.balance })}</s-text>
        </s-stack>
      )}
      {data && !(data.earned > 0) && <s-text tone="subdued">{i18n.translate("post_none", { reason: data.reason || "" })}</s-text>}
    </s-section>
  );
}
