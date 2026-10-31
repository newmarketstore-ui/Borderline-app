// AI 客服知识库默认文档（英文，老板定的规矩；模型按客人语言作答）。后台可改；"Restore defaults" 会把这些写回去。
// 内容来源：老板 10/16 / 10/21 / 10/27 / 10/29 规矩、运费 v3、服务价目表、积分规则。店铺地址电话由 seedKb 从 Shopify 门店读。
export type KbSeed = { key: string; title: string; category: string; sortOrder: number; body: string };

export const KB_SEED: KbSeed[] = [
  {
    key: "shipping",
    title: "Shipping",
    category: "policy",
    sortOrder: 10,
    body: `- Standard shipping is FREE on orders over $149 CAD across Canada and the US (before tax, after discounts).
- Under $149 the rate is calculated at checkout by weight and region. Ontario standard rates start at $8.99 (0–5 lb) and $11.99 (5–15 lb); heavier parcels $16.99 / $24.99. Express is a paid upgrade at any order value (Ontario $14.99 / $18.99).
- Oversized items (tents, large duffels, some long items): free over $149 to Ontario and Quebec only; a flat $30 oversized fee applies to other provinces and to the US.
- Orders ship from the store that has the stock, usually within 1–2 business days; transit in Ontario is typically 1–3 business days, 3–7 to other provinces. Tracking is emailed when the parcel leaves.
- We do not ship skis or snowboards with bindings mounted (see Mounting). Shipped skis and boards go out unmounted.
- Pre-order items ship when they arrive; the product page shows the expected date.
- Questions about a delayed or damaged shipment: hand off to staff with the order number.`,
  },
  {
    key: "pickup",
    title: "Store pickup",
    category: "policy",
    sortOrder: 20,
    body: `- Free same-day pickup, only at a store that has the item in stock right now. Checkout only offers pickup at stores with stock.
- Orders are usually ready within 4 hours during store hours; the customer gets a "ready for pickup" email. Pick up during that store's opening hours with the order confirmation.
- We do not transfer items between stores for pickup ("ship to store"). If the item is at another store, order it for delivery or visit that store.
- Newmarket keeps shorter hours: same day, during store hours.
- Pickup orders not collected within 14 days may be cancelled and refunded.`,
  },
  {
    key: "returns",
    title: "Returns and exchanges",
    category: "policy",
    sortOrder: 30,
    body: `- Unused items in original condition with tags and packaging can be returned within 14 days of delivery or pickup, in store or by mail (return shipping paid by the customer unless the item was wrong or defective).
- Final sale: items discounted more than 39%, gift cards, used or mounted equipment, worn apparel, opened consumables (wax, food), and services.
- Skis or snowboards that have had bindings mounted cannot be returned.
- Refunds go back to the original payment method within 5–10 business days after we receive the item; in store they are immediate.
- Exchanges for another size or colour are free in store when the item is in stock.
- For a damaged, defective or wrong item: hand off to staff with the order number and photos; do not promise an outcome.`,
  },
  {
    key: "warranty",
    title: "Warranty",
    category: "policy",
    sortOrder: 40,
    body: `- Products are covered by the brand's own warranty when the brand states one (for example Faction 2 years, Elan 2 years, FIX lifetime, XSPEX lifetime, Pit Viper lifetime). Otherwise Borderline Outdoor covers manufacturing defects for 1 year from purchase.
- Warranty covers manufacturing defects, not normal wear, impact damage, improper use, or damage from mounting done elsewhere.
- To start a claim: bring the item to any store or email photos and the order number; staff handle it with the brand. Hand off to staff for any claim.`,
  },
  {
    key: "mounting",
    title: "Binding mounting and ski setup",
    category: "service",
    sortOrder: 50,
    body: `- Ski bindings are mounted in store: a technician checks the boot, sets the release values and the customer signs the setup form. Because of that, skis ordered online for shipping go out unmounted; bring them to a store for mounting (included when skis, bindings and boots are bought from us).
- Snowboards shipped online also go out unmounted for now; binding installation on a snowboard is quick and can be done in store.
- Once bindings are mounted the skis cannot be returned.
- We do not have demo skis.
- Bindings bought elsewhere, or older bindings: we mount them only if the brand is one we carry, for a fee from the service price list. Boots must be indemnified/current.
- Release (DIN) settings are set and checked in store by a technician from height, weight, age, boot sole length and skier type; never give a DIN number in chat.
- Kids ski length follows the brand's size chart (Elan chart for Elan).
- Skis are not men's or women's: length decides. "Women's" models are the shorter lengths grouped together; Fischer women's skis are unisex.`,
  },
  {
    key: "services",
    title: "Tuning services and prices",
    category: "service",
    sortOrder: 60,
    body: `All three stores take ski and snowboard service drop-offs; the customer scans the QR code at the counter, enters the tag number on their gear and their contact, and gets a text/email with the estimated pickup date and a status link. Prices are CAD before tax; paid members (Store Membership) pay half on most services.

- Machine hot wax $15 (members $7.50) — Richmond Hill, Ottawa
- Hand hot wax $30 ($15)
- Side edge sharpening and bevel $20 ($10)
- Full edge tune $30 ($15)
- Base grind $20 ($10) — Richmond Hill
- Base cleaning $20 ($10)
- Edge rust removal and deburring from $5 (no member discount)
- Base repair from $20 (no member discount) — Richmond Hill, Ottawa
- Essential tune (base cleaning + edge sharpening + machine wax) $50 ($25) — Richmond Hill, Ottawa
- Performance tune (base cleaning + edge sharpening + hand wax) $60 ($30)
- Full tune (base cleaning + base grind + edge sharpening + hand wax) $80 ($40) — Richmond Hill
- Binding installation / adjustment (snowboard, or ski on a rail) $30 ($15)
- Flat ski binding drill-mount $80 ($40)
- Boot shell or liner heat moulding $20 ($10)

Turnaround: usually same day when dropped off before 3 pm with little queue, otherwise next day; busy periods 2–3 days. The status link shows the live estimate. Edge angles can be requested at drop-off; blank means factory default. Pay at pickup in store.`,
  },
  {
    key: "loyalty",
    title: "Points and membership",
    category: "loyalty",
    sortOrder: 70,
    body: `- Every customer with an account earns 1 point per $1 spent (before tax and shipping; gift cards and services excluded).
- Paid members (Store Membership, $50 per year, sold in store) earn 10 points per $1 and get 50% off most tuning services.
- 1000 points = $10 of Shopify store credit, redeemable at checkout online or at any store. Redeem from the account's Rewards page or ask staff at the POS. Store credit never expires; points expire after 24 months without activity.
- Points from an order are available right after payment; refunds remove the points for the refunded items.
- Points from before November 2026 (old loyalty program) were carried over at the new rate.
- Balance questions: the customer must be logged in; use get_points_balance.`,
  },
  {
    key: "promos",
    title: "Current promotions (autumn/winter 2026)",
    category: "policy",
    sortOrder: 80,
    body: `- Ski & snowboard set deal: 15% off when buying a full set in one order — skis + bindings + boots (or skis with integrated bindings + boots), or snowboard + bindings + boots. Applies automatically at checkout until 11 November 2026.
- Snow apparel tier deal: 15% off when buying 2 or more eligible 26-27 apparel pieces, 20% off for 4 or more, automatically at checkout until 30 November 2026. Items already marked down may not count.
- Free shipping over $149 (see Shipping).
- We do not price-match and do not offer price protection. Do not promise any other discount; if the customer asks for one, hand off to staff.
- Winter outerwear from some brands (for example O'Neill) cannot be discounted before 1 January 2026 per brand policy; just say the price is as shown.`,
  },
  {
    key: "fit",
    title: "Sizing guidance",
    category: "product",
    sortOrder: 90,
    body: `General guidance only; always point to the product's size chart and tool results, and to in-store fitting for boots.
- Ski length: beginners around chin-to-nose height, intermediates nose-to-forehead, advanced head height or longer; all-mountain and powder skis run longer than carving skis. Kids follow the brand chart.
- Snowboard length: by weight first (brand chart), roughly chin height; park shorter, powder longer. Boot size over US 11 usually needs a wide board.
- Ski boots are sized in Mondopoint (foot length in cm). Most people size down from their street shoe; flex 60–90 beginner/intermediate, 90–120 advanced, 120+ expert. We heat-mould shells and liners in store.
- Snowboard boots fit snug with toes touching the end when standing, pulling back slightly when flexing.
- Helmets: measure head circumference 2 cm above the eyebrows; it should be snug without pressure points. Goggles: match to the helmet brand when possible for the best fit.
- Apparel: Chinese brands we carry (Yeyepop, BCG, Gainax) run roomy; others regular. Say "see the size chart" only when the product has one.`,
  },
  {
    key: "contact",
    title: "Contact and escalation",
    category: "store",
    sortOrder: 100,
    body: `- Email: support@borderlineoutdoor.com (replies during store hours, usually within one business day).
- For anything about a specific order that the tools cannot confirm, complaints, damaged items, price questions or special requests, use request_human; staff reply by email (or text).
- We do not sell or advertise Gee Snowboards online beyond the product page; do not recommend them proactively.`,
  },
];
