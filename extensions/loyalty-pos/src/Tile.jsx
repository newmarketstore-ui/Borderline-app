// 首页智能网格瓷砖：购物车里有客人就显示余额，点开弹窗兑换。
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { getMember } from "./api";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [state, setState] = useState({ customerId: null, summary: null, error: null });

  useEffect(() => {
    const read = (cart) => cart?.customer?.id ?? null;
    let last = read(shopify.cart.current.value);
    const load = async (customerId) => {
      if (!customerId) return setState({ customerId: null, summary: null, error: null });
      try {
        const summary = await getMember(customerId);
        setState({ customerId, summary, error: null });
      } catch (e) {
        setState({ customerId, summary: null, error: e.message });
      }
    };
    load(last);
    const unsubscribe = shopify.cart.current.subscribe((cart) => {
      const id = read(cart);
      if (id !== last) {
        last = id;
        load(id);
      }
    });
    return () => unsubscribe && unsubscribe();
  }, []);

  const { customerId, summary, error } = state;
  const subheading = !customerId
    ? i18n.translate("tile_no_customer")
    : error
      ? error
      : summary
        ? i18n.translate("tile_balance", { points: summary.balance, tier: summary.isPaidMember ? "Paid member" : "Member" })
        : i18n.translate("tile_loading");

  return (
    <s-tile
      heading={i18n.translate("tile_heading")}
      subheading={subheading}
      enabled={Boolean(customerId)}
      onClick={() => shopify.action.presentModal()}
    />
  );
}
