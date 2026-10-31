// AI 客服的工具：全部只读。商品 / 库存走 Storefront API（公开令牌，和冬季主题同一条路），订单走离线 Admin，工单 / 积分读自己的库。
import type Anthropic from "@anthropic-ai/sdk";

import prisma from "../db.server";
import { STORE_SEED } from "../lib/serviceRules";
import { normalizeOrderName } from "../lib/supportRules";
import { getAdminForShop, gql } from "./loyalty.server";
import { getStores, queueAhead, statusUrl, ticketsForCustomer } from "./services.server";

const STOREFRONT_VERSION = "2025-07";
const SF_TOKEN = () => process.env.STOREFRONT_PUBLIC_TOKEN?.trim() || "";

export type ToolContext = {
  shop: string;
  conversationId: string;
  customerGid: string | null;
  memberId: string | null;
  contactKnown: boolean;
};

export type ToolRun = { name: string; input: Record<string, unknown>; ok: boolean; ms: number; summary?: string };

export const SUPPORT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "Search the online catalogue. Use keywords for brand / model / category ('snow pants', 'ski jacket women', 'snowboard 155') and filters for colour, type and price. Returns up to 10 products with price, availability, sizes in stock and image. For a colour request ALWAYS set color_family instead of putting the colour in the query (colour names live in option values, not titles). Call get_product for details or per-store stock.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search words (category / brand / model), in English; leave the colour out" },
        color_family: { type: "string", enum: ["black", "blue", "gray", "white", "green", "pink", "red", "purple", "brown", "multicolor", "orange", "yellow", "beige", "silver", "navy", "gold"], description: "Colour family the customer asked for" },
        product_type: { type: "string", description: "Exact Shopify product type when known, e.g. 'Snow Pants', 'Snow Jacket', 'Snow Bib', 'Mid Layers', 'Base Layers', 'Ski Board', 'Snowboard', 'Ski Boot', 'Snowboard Boot', 'Helmet', 'Goggles'" },
        max_price: { type: "number", description: "CAD upper limit" },
        size: { type: "string", description: "Size the customer needs (e.g. M, L, 10.5, 165) — only products with that size in stock are returned" },
        in_stock_only: { type: "boolean", description: "Default true" },
      },
      required: ["query"],
    },
  },
  {
    name: "show_products",
    description:
      "Show product cards (image, title, price, link) in the chat window for up to 4 products you are recommending. Call it after you have decided which products to suggest, then describe them briefly in text. Use the handles from search_products / get_product.",
    input_schema: {
      type: "object",
      properties: { handles: { type: "array", items: { type: "string" }, maxItems: 4 } },
      required: ["handles"],
    },
  },
  {
    name: "get_product",
    description:
      "Full details of one product by handle (the last part of its URL): description, specs, FAQ, every variant with price and online availability, and live stock per store (Richmond Hill / Newmarket / Ottawa). Always use this before answering stock, price or size questions.",
    input_schema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
    },
  },
  {
    name: "get_order_status",
    description:
      "Status of an order: fulfillment, tracking, pickup. For a logged-in customer, omit the arguments to list their recent orders, or give order_number. For a guest, order_number AND the email on the order are both required.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "string", description: "e.g. #23157" },
        email: { type: "string" },
      },
    },
  },
  {
    name: "get_service_tickets",
    description:
      "Ski / snowboard tuning service tickets (wax, edges, mount) with status and estimated pickup date. Logged-in customers: no arguments. Guests: give tag_number plus the email or phone used at drop-off.",
    input_schema: {
      type: "object",
      properties: {
        tag_number: { type: "integer" },
        email: { type: "string" },
        phone: { type: "string" },
      },
    },
  },
  {
    name: "get_points_balance",
    description: "Points balance and membership tier of the logged-in customer. Only works when the customer is logged in.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "request_human",
    description:
      "Hand this conversation to store staff. Use when the question cannot be answered from tools or the knowledge base, for complaints, order problems, price disputes, or when the customer asks for a person. Staff reply by email (or SMS) later.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["cannot_answer", "customer_asked", "order_issue", "complaint", "price_or_discount", "other"] },
        summary: { type: "string", description: "One line for staff: what the customer needs" },
      },
      required: ["reason", "summary"],
    },
  },
];

// ───────────────────────────── Storefront ─────────────────────────────

async function storefront<T>(shop: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const token = SF_TOKEN();
  if (!token) throw new Error("STOREFRONT_PUBLIC_TOKEN not set");
  const res = await fetch(`https://${shop}/api/${STOREFRONT_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Shopify-Storefront-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Storefront HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`Storefront: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("Storefront: empty response");
  return json.data;
}

const PRODUCT_FIELDS = `
  title handle vendor productType availableForSale onlineStoreUrl
  priceRange { minVariantPrice { amount } maxVariantPrice { amount } }
  compareAtPriceRange { maxVariantPrice { amount } }
`;

const SEARCH_QUERY = `#graphql
  query SupportSearch($q: String!, $filters: [ProductFilter!]) {
    search(query: $q, first: 20, types: [PRODUCT], productFilters: $filters) {
      nodes { ... on Product { ${PRODUCT_FIELDS}
        featuredImage { url(transform: { maxWidth: 400 }) }
        variants(first: 60) { nodes { title availableForSale } }
      } }
    }
  }`;

const CARDS_QUERY = `#graphql
  query SupportCards($q: String!) {
    products(first: 8, query: $q) {
      nodes { ${PRODUCT_FIELDS} featuredImage { url(transform: { maxWidth: 400 }) } }
    }
  }`;

const PRODUCT_QUERY = `#graphql
  query SupportProduct($handle: String!) {
    product(handle: $handle) {
      ${PRODUCT_FIELDS}
      description
      tags
      options { name values }
      faq: metafield(namespace: "custom", key: "pdp_faq") { value }
      overview: metafield(namespace: "custom", key: "overview") { value }
      tech: metafield(namespace: "custom", key: "technical_details") { value }
      sizeChart: metafield(namespace: "custom", key: "size_chart") { value }
      variants(first: 60) {
        nodes {
          title availableForSale currentlyNotInStock quantityAvailable
          price { amount } compareAtPrice { amount }
          storeAvailability(first: 10) { nodes { available quantityAvailable pickUpTime location { id name } } }
        }
      }
    }
  }`;

type SfProduct = {
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  availableForSale: boolean;
  onlineStoreUrl: string | null;
  priceRange: { minVariantPrice: { amount: string }; maxVariantPrice: { amount: string } };
  compareAtPriceRange: { maxVariantPrice: { amount: string } };
};

const money = (a: string | undefined | null) => (a == null ? null : `$${Number(a).toFixed(2)}`);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

function priceLabel(p: SfProduct) {
  const lo = Number(p.priceRange.minVariantPrice.amount);
  const hi = Number(p.priceRange.maxVariantPrice.amount);
  const cmp = Number(p.compareAtPriceRange?.maxVariantPrice?.amount ?? 0);
  const base = lo === hi ? `$${lo.toFixed(2)}` : `$${lo.toFixed(2)}–$${hi.toFixed(2)}`;
  return cmp > hi ? `${base} (was $${cmp.toFixed(2)})` : base;
}

function storeNameByLocation(stores: Array<{ key: string; name: string; shopifyLocationId: string | null }>) {
  const map = new Map<string, string>();
  for (const s of stores) if (s.shopifyLocationId) map.set(s.shopifyLocationId.split("/").pop()!, s.name);
  for (const s of STORE_SEED) if (s.shopifyLocationId) map.set(s.shopifyLocationId.split("/").pop()!, s.name);
  return map;
}

type SfSearchProduct = SfProduct & { featuredImage: { url: string } | null; variants: { nodes: Array<{ title: string; availableForSale: boolean }> } };

async function searchProducts(shop: string, input: { query: string; color_family?: string; product_type?: string; max_price?: number; size?: string; in_stock_only?: boolean }) {
  const filters: Array<Record<string, unknown>> = input.in_stock_only === false ? [] : [{ available: true }];
  if (input.size?.trim()) filters.push({ variantOption: { name: "Size", value: input.size.trim() } });
  if (input.color_family) filters.push({ tag: `color-${input.color_family.toLowerCase().replace(/\s+/g, "-")}` });
  if (input.product_type) filters.push({ productType: input.product_type });
  if (input.max_price && input.max_price > 0) filters.push({ price: { max: input.max_price } });
  const q = input.query?.trim() || input.product_type || "*";
  const run = async (query: string) => (await storefront<{ search: { nodes: SfSearchProduct[] } }>(shop, SEARCH_QUERY, { q: query, filters })).search.nodes.filter((n) => n && n.handle);
  let items = await run(q);
  // 关键词太窄（比如 "pants" 对不上 "Snow Pants" 标题）时，换更宽的词只靠筛选再搜一次
  if (!items.length && (input.color_family || input.product_type)) items = await run(input.product_type ?? q.split(/\s+/).pop() ?? q);
  if (!items.length) return { results: [], note: "No products matched. Try broader words, drop a filter, or hand off to staff." };
  return {
    results: items.map((p) => ({
      title: p.title,
      handle: p.handle,
      brand: p.vendor,
      type: p.productType,
      price: priceLabel(p),
      available_online: p.availableForSale,
      sizes_in_stock: p.variants.nodes.filter((v) => v.availableForSale).map((v) => v.title).slice(0, 12),
      image: p.featuredImage?.url ?? null,
      url: p.onlineStoreUrl ?? `https://borderlinestore.ca/products/${p.handle}`,
    })),
    total_shown: items.length,
    note: [input.color_family ? `Filtered by colour family "${input.color_family}".` : null, input.size ? `Only products with size ${input.size} in stock.` : null, items.length >= 20 ? "More results exist; narrow with product_type / max_price." : null].filter(Boolean).join(" ") || undefined,
  };
}

export type ProductCard = { handle: string; title: string; price: string; image: string | null; url: string; available: boolean; brand: string };

/** 给聊天窗渲染的商品卡（按 handle 取）。 */
export async function productCards(shop: string, handles: string[]): Promise<ProductCard[]> {
  const hs = [...new Set(handles.map((h) => String(h).trim().replace(/^.*\/products\//, "").split(/[?#]/)[0]).filter(Boolean))].slice(0, 4);
  if (!hs.length) return [];
  const data = await storefront<{ products: { nodes: Array<SfProduct & { featuredImage: { url: string } | null }> } }>(shop, CARDS_QUERY, { q: hs.map((h) => `handle:${h}`).join(" OR ") });
  const byHandle = new Map(data.products.nodes.map((p) => [p.handle, p]));
  return hs
    .map((h) => byHandle.get(h))
    .filter((p): p is SfProduct & { featuredImage: { url: string } | null } => Boolean(p))
    .map((p) => ({ handle: p.handle, title: p.title, price: priceLabel(p), image: p.featuredImage?.url ?? null, url: p.onlineStoreUrl ?? `https://borderlinestore.ca/products/${p.handle}`, available: p.availableForSale, brand: p.vendor }));
}

function parseJsonish(v: string | null | undefined): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function getProduct(shop: string, input: { handle: string }) {
  const handle = String(input.handle ?? "")
    .trim()
    .replace(/^.*\/products\//, "")
    .split(/[?#]/)[0];
  const [data, stores] = await Promise.all([
    storefront<{ product: (SfProduct & {
      description: string;
      tags: string[];
      options: Array<{ name: string; values: string[] }>;
      faq: { value: string } | null;
      overview: { value: string } | null;
      tech: { value: string } | null;
      sizeChart: { value: string } | null;
      variants: { nodes: Array<{
        title: string;
        availableForSale: boolean;
        currentlyNotInStock: boolean;
        quantityAvailable: number | null;
        price: { amount: string };
        compareAtPrice: { amount: string } | null;
        storeAvailability: { nodes: Array<{ available: boolean; quantityAvailable: number; pickUpTime: string; location: { id: string; name: string } }> };
      }> };
    }) | null }>(shop, PRODUCT_QUERY, { handle }),
    getStores(shop, { includeInactive: true }),
  ]);
  const p = data.product;
  if (!p) return { error: `No product with handle "${handle}" (it may be offline for the season or the handle is wrong — try search_products).` };
  const names = storeNameByLocation(stores);
  const variants = p.variants.nodes.map((v) => {
    const byStore: Record<string, number> = {};
    for (const s of v.storeAvailability.nodes) {
      const name = names.get(s.location.id.split("/").pop()!) ?? s.location.name;
      // "2-4 days" 之类 = Shopify 要从别店调货，不算该店有货（老板 10/21：自提只在有货的店）
      const transfer = /day/i.test(s.pickUpTime ?? "");
      byStore[name] = transfer ? 0 : Math.max(0, s.quantityAvailable ?? 0);
    }
    return {
      option: v.title,
      price: money(v.price.amount),
      was: v.compareAtPrice ? money(v.compareAtPrice.amount) : null,
      available_online: v.availableForSale,
      backorder: v.currentlyNotInStock,
      units_total: v.quantityAvailable,
      units_by_store: byStore,
    };
  });
  const faq = parseJsonish(p.faq?.value);
  return {
    title: p.title,
    handle: p.handle,
    brand: p.vendor,
    type: p.productType,
    url: p.onlineStoreUrl ?? `https://borderlinestore.ca/products/${p.handle}`,
    price: priceLabel(p),
    options: p.options.map((o) => `${o.name}: ${o.values.join(", ")}`),
    description: clip(p.description, 1500),
    overview: clip(typeof p.overview?.value === "string" ? p.overview.value : null, 1200),
    technical_details: clip(typeof p.tech?.value === "string" ? p.tech.value : null, 1500),
    size_chart: clip(typeof p.sizeChart?.value === "string" ? p.sizeChart.value : null, 1200),
    faq: Array.isArray(faq) ? faq.slice(0, 12) : clip(typeof faq === "string" ? faq : null, 1200),
    tags: p.tags.filter((t) => !/^(pmax|no-ads|camping-offline|apparel-tier|ai-)/i.test(t)).slice(0, 25),
    variants,
    stock_note: "units_by_store counts only stock physically at that store (same-day pickup there). 0 at every store but available_online = ships from another location.",
  };
}

// ───────────────────────────── Admin（订单） ─────────────────────────────

const ORDER_FIELDS = `
  name createdAt displayFulfillmentStatus displayFinancialStatus cancelledAt
  email
  totalPriceSet { shopMoney { amount } }
  shippingLine { title }
  lineItems(first: 20) { nodes { title quantity variantTitle } }
  fulfillments(first: 5) { status deliveredAt estimatedDeliveryAt trackingInfo { company number url } }
  fulfillmentOrders(first: 5) { nodes { status deliveryMethod { methodType } assignedLocation { name } } }
`;

type AdminOrder = {
  name: string;
  createdAt: string;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  cancelledAt: string | null;
  email: string | null;
  totalPriceSet: { shopMoney: { amount: string } };
  shippingLine: { title: string } | null;
  lineItems: { nodes: Array<{ title: string; quantity: number; variantTitle: string | null }> };
  fulfillments: Array<{ status: string; deliveredAt: string | null; estimatedDeliveryAt: string | null; trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }> }>;
  fulfillmentOrders: { nodes: Array<{ status: string; deliveryMethod: { methodType: string } | null; assignedLocation: { name: string } | null }> };
};

function orderView(o: AdminOrder) {
  const pickup = o.fulfillmentOrders.nodes.find((f) => f.deliveryMethod?.methodType === "PICK_UP");
  return {
    order: o.name,
    placed: o.createdAt.slice(0, 10),
    payment: o.displayFinancialStatus,
    fulfillment: o.cancelledAt ? "CANCELLED" : o.displayFulfillmentStatus,
    total: money(o.totalPriceSet.shopMoney.amount),
    delivery: pickup ? `Pickup at ${pickup.assignedLocation?.name ?? "store"} (${pickup.status})` : (o.shippingLine?.title ?? "Shipping"),
    items: o.lineItems.nodes.map((l) => `${l.quantity}× ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`),
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => ({ carrier: t.company, number: t.number, url: t.url, status: f.status, delivered: f.deliveredAt?.slice(0, 10) ?? null, eta: f.estimatedDeliveryAt?.slice(0, 10) ?? null }))),
  };
}

async function getOrderStatus(ctx: ToolContext, input: { order_number?: string; email?: string }) {
  const admin = await getAdminForShop(ctx.shop);
  const name = normalizeOrderName(input.order_number);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (ctx.customerGid && !name) {
    const d = await gql<{ customer: { orders: { nodes: AdminOrder[] } } | null }>(
      admin,
      `#graphql query SupportMyOrders($id: ID!) { customer(id: $id) { orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } } }`,
      { id: ctx.customerGid },
    );
    const orders = d.customer?.orders.nodes ?? [];
    return orders.length ? { orders: orders.map(orderView) } : { orders: [], note: "No orders on this account." };
  }
  if (!name) return { error: "Need the order number (e.g. #23157)." };
  if (!ctx.customerGid && !email) return { error: "For a guest, the email used on the order is also required before I can look it up." };
  const d = await gql<{ orders: { nodes: Array<AdminOrder & { customer: { id: string } | null }> } }>(
    admin,
    `#graphql query SupportOrder($q: String!) { orders(first: 3, query: $q) { nodes { ${ORDER_FIELDS} customer { id } } } }`,
    { q: `name:${name}` },
  );
  const o = d.orders.nodes.find((x) => x.name === name) ?? d.orders.nodes[0];
  if (!o) return { error: `No order ${name} found.` };
  const owns = (ctx.customerGid && o.customer?.id === ctx.customerGid) || (email && (o.email ?? "").toLowerCase() === email);
  if (!owns) return { error: "The email does not match that order. Ask the customer to check the email on their confirmation, or hand off to staff." };
  return { orders: [orderView(o)] };
}

// ───────────────────────────── 工单 / 积分 ─────────────────────────────

async function getServiceTickets(ctx: ToolContext, input: { tag_number?: number; email?: string; phone?: string }) {
  const stores = await getStores(ctx.shop, { includeInactive: true });
  let tickets;
  if (ctx.customerGid) {
    const m = ctx.memberId ? await prisma.member.findUnique({ where: { id: ctx.memberId }, select: { email: true, phone: true } }) : null;
    tickets = await ticketsForCustomer(ctx.shop, { customerGid: ctx.customerGid, email: m?.email, phone: m?.phone }, 10);
  } else {
    const tag = Number(input.tag_number);
    if (!Number.isFinite(tag) || (!input.email && !input.phone)) return { error: "For a guest I need the tag number plus the email or phone used at drop-off." };
    const all = await ticketsForCustomer(ctx.shop, { email: input.email ?? null, phone: input.phone ?? null }, 20);
    tickets = all.filter((t) => t.tagNumber === tag);
    if (!tickets.length) return { error: "No ticket matches that tag number and contact." };
  }
  const out = [];
  for (const t of tickets) {
    const open = ["received", "in_progress", "on_hold"].includes(t.status);
    out.push({
      tag: t.tagNumber,
      store: stores.find((s) => s.key === t.storeKey)?.name ?? t.storeKey,
      status: t.status,
      services: (t.services as Array<{ name: string }>).map((s) => s.name),
      dropped_off: t.createdAt.toISOString().slice(0, 10),
      estimated_pickup: t.etaAt ? t.etaAt.toISOString().slice(0, 10) : null,
      queue_ahead: open ? await queueAhead(ctx.shop, t.storeKey, t.createdAt) : 0,
      ready_since: t.readyAt?.toISOString().slice(0, 10) ?? null,
      status_page: statusUrl(t.token),
    });
  }
  return { tickets: out };
}

async function getPointsBalance(ctx: ToolContext) {
  if (!ctx.customerGid) return { error: "Customer is not logged in. Ask them to log in to their account to see points." };
  const m = await prisma.member.findUnique({ where: { shopifyCustomerId: ctx.customerGid } });
  if (!m) return { balance: 0, tier: "standard", note: "No points record yet — points start with the first order after joining." };
  const now = new Date();
  const paid = m.tier === "paid" && (!m.paidUntil || m.paidUntil > now);
  return {
    balance: m.balanceCached,
    value_cad: `$${(Math.floor(m.balanceCached / 1000) * 10).toFixed(2)} redeemable now (1000 points = $10 store credit)`,
    tier: paid ? "paid member (10 points per $1)" : "standard (1 point per $1)",
    paid_until: paid && m.paidUntil ? m.paidUntil.toISOString().slice(0, 10) : null,
  };
}

async function requestHuman(ctx: ToolContext, input: { reason: string; summary: string }) {
  await prisma.supportConversation.update({
    where: { id: ctx.conversationId },
    data: { status: "handoff", handoffReason: String(input.reason ?? "other").slice(0, 40), handoffSummary: String(input.summary ?? "").slice(0, 500), handoffAt: new Date() },
  });
  return {
    ok: true,
    contact_known: ctx.contactKnown,
    next: ctx.contactKnown
      ? "Staff will see this conversation in their dashboard and reply by email during store hours. Tell the customer that in one sentence."
      : "Staff will see this conversation, but we have no email or phone for the customer yet. Ask for an email (or phone number) so staff can reply; the chat window will also show a contact form.",
  };
}

// ───────────────────────────── 分发 ─────────────────────────────

export async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_products":
      return searchProducts(ctx.shop, input as Parameters<typeof searchProducts>[1]);
    case "show_products": {
      const cards = await productCards(ctx.shop, ((input as { handles?: unknown }).handles as string[]) ?? []);
      return { shown: cards.map((c) => c.handle), cards, note: cards.length ? "Cards are now visible to the customer; describe them briefly, do not repeat prices already on the cards." : "No valid handles." };
    }
    case "get_product":
      return getProduct(ctx.shop, input as { handle: string });
    case "get_order_status":
      return getOrderStatus(ctx, input as { order_number?: string; email?: string });
    case "get_service_tickets":
      return getServiceTickets(ctx, input as { tag_number?: number; email?: string; phone?: string });
    case "get_points_balance":
      return getPointsBalance(ctx);
    case "request_human":
      return requestHuman(ctx, input as { reason: string; summary: string });
    default:
      return { error: `Unknown tool ${name}` };
  }
}
