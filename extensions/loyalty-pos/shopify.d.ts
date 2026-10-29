import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Tile.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.tile.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Modal.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.home.modal.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/CustomerBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.customer-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/PostPurchaseBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/pos.purchase.post.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/api.js' {
  const shopify:
    | import('@shopify/ui-extensions/pos.home.tile.render').Api
    | import('@shopify/ui-extensions/pos.home.modal.render').Api
    | import('@shopify/ui-extensions/pos.customer-details.block.render').Api
    | import('@shopify/ui-extensions/pos.purchase.post.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
