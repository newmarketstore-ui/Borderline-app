// 会员积分服务层：会员 upsert、只追加流水、余额缓存、客户 metafield 镜像、规则读写、员工调分。
// 计分公式在 app/lib/loyaltyMath.ts（纯函数）；这里只管 I/O。
import { Prisma, type Member } from "@prisma/client";

import prisma from "../db.server";
import type { EarnLine } from "../lib/loyaltyMath";
import type { OrderCustomer } from "../lib/shopifyPayload";
import {
  REDEEM_CHANNELS,
  REDEEM_ROUNDINGS,
  type RedeemRounding,
  type RedeemWindowRule,
} from "../lib/redeemMath";
import { appendLedger } from "./ledger.server";
import type { AdminGraphql } from "./shopAdmin.server";

// ── 规则 ────────────────────────────────────────────────────────────────────

export type LoyaltySettings = {
  pointsPerDollar: number;
  redeemPointsPerDollar: number;
  minRedeemPoints: number;
  redeemStepPoints: number;
  excludedProductTypes: string[];
  excludedTags: string[];
  earnOnShipping: boolean;
  earnOnTax: boolean;
  pendingDays: number;
  expiryMonths: number | null;
  expiryMode: ExpiryMode;
  paidTierMultiplier: number;
  earnRequiresMember: boolean;
  memberTag: string;
  membershipProductTag: string;
  membershipMonths: number;
  excludeDiscountedItems: boolean;
  redeemMethod: RedeemMethod;
  storeCreditExpiryMonths: number | null;
  redeemAmountIsTaxInclusive: boolean;
  assumedTaxRate: number;
  redeemRounding: RedeemRounding;
  redeemRequiresMember: boolean;
  redeemCodePrefix: string;
  redeemExpiryHours: number;
  signupBonusPoints: number;
  migrationPointsMultiplier: number;
  posAllowStoreCredit: boolean;
  posAllowCartDiscount: boolean;
  cartDiscountExpiryMinutes: number;
  updatedBy: string | null;
  updatedAt: string | null;
  persisted: boolean; // false = 库里还没有这一行，用的是下面的默认值
};

export type RedeemMethod = "store_credit" | "discount_code";
export const REDEEM_METHODS: RedeemMethod[] = ["store_credit", "discount_code"];
export type ExpiryMode = "off" | "inactivity";
export const EXPIRY_MODES: ExpiryMode[] = ["off", "inactivity"];

// 默认值 = 老板 2026-10-29 定规：
// 普通会员（任何留资下单的客人）$1 小计 = 1 分；付费会员 $1 = 10 分（paidTierMultiplier）；不含税 / 运费；Gift Card / Service 不给分；向下取整；
// 兑换 100 分 = $1，1000 分起、1000 分一档，发到顾客的 Shopify Store Credit（线上结账和 POS 原生可用）。
// Appstle 旧分 10 分 = $1，迁移时 ×10 保值（migrationPointsMultiplier）。
export const DEFAULT_SETTINGS: LoyaltySettings = {
  pointsPerDollar: 1,
  redeemPointsPerDollar: 100,
  minRedeemPoints: 1000,
  redeemStepPoints: 1000,
  excludedProductTypes: [],
  excludedTags: ["Gift Card", "Service"],
  earnOnShipping: false,
  earnOnTax: false,
  pendingDays: 0,
  expiryMonths: null,
  expiryMode: "off",
  paidTierMultiplier: 10,
  earnRequiresMember: false,
  memberTag: "gold-membership",
  membershipProductTag: "Membership",
  membershipMonths: 12,
  excludeDiscountedItems: false,
  redeemMethod: "store_credit",
  storeCreditExpiryMonths: null,
  redeemAmountIsTaxInclusive: false,
  assumedTaxRate: 0.13,
  redeemRounding: "nearest_cent",
  redeemRequiresMember: false,
  redeemCodePrefix: "POINTS",
  redeemExpiryHours: 24,
  signupBonusPoints: 0,
  migrationPointsMultiplier: 10,
  posAllowStoreCredit: true,
  posAllowCartDiscount: true,
  cartDiscountExpiryMinutes: 120,
  updatedBy: null,
  updatedAt: null,
  persisted: false,
};

const asRounding = (v: string): RedeemRounding =>
  (REDEEM_ROUNDINGS as string[]).includes(v) ? (v as RedeemRounding) : "nearest_cent";
const asMethod = (v: string): RedeemMethod => ((REDEEM_METHODS as string[]).includes(v) ? (v as RedeemMethod) : "store_credit");
const asExpiryMode = (v: string): ExpiryMode => ((EXPIRY_MODES as string[]).includes(v) ? (v as ExpiryMode) : "off");

export async function getLoyaltySettings(shop: string): Promise<LoyaltySettings> {
  const row = await prisma.loyaltyConfig.findUnique({ where: { shopDomain: shop } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    pointsPerDollar: Number(row.pointsPerDollar.toString()),
    redeemPointsPerDollar: row.redeemPointsPerDollar,
    minRedeemPoints: row.minRedeemPoints,
    redeemStepPoints: row.redeemStepPoints,
    excludedProductTypes: row.excludedProductTypes,
    excludedTags: row.excludedTags,
    earnOnShipping: row.earnOnShipping,
    earnOnTax: row.earnOnTax,
    pendingDays: row.pendingDays,
    expiryMonths: row.expiryMonths,
    expiryMode: asExpiryMode(row.expiryMode),
    paidTierMultiplier: Number(row.paidTierMultiplier.toString()),
    earnRequiresMember: row.earnRequiresMember,
    memberTag: row.memberTag,
    membershipProductTag: row.membershipProductTag,
    membershipMonths: row.membershipMonths,
    excludeDiscountedItems: row.excludeDiscountedItems,
    redeemMethod: asMethod(row.redeemMethod),
    storeCreditExpiryMonths: row.storeCreditExpiryMonths,
    redeemAmountIsTaxInclusive: row.redeemAmountIsTaxInclusive,
    assumedTaxRate: Number(row.assumedTaxRate.toString()),
    redeemRounding: asRounding(row.redeemRounding),
    redeemRequiresMember: row.redeemRequiresMember,
    redeemCodePrefix: row.redeemCodePrefix,
    redeemExpiryHours: row.redeemExpiryHours,
    signupBonusPoints: row.signupBonusPoints,
    migrationPointsMultiplier: Number(row.migrationPointsMultiplier.toString()),
    posAllowStoreCredit: row.posAllowStoreCredit,
    posAllowCartDiscount: row.posAllowCartDiscount,
    cartDiscountExpiryMinutes: row.cartDiscountExpiryMinutes,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    persisted: true,
  };
}

export type SettingsInput = Omit<LoyaltySettings, "updatedBy" | "updatedAt" | "persisted">;

const splitList = (v: string) =>
  Array.from(new Set(v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)));

const truthy = (v: FormDataEntryValue | null) => v === "on" || v === "true";

/** 表单字段 → 校验后的规则。返回错误列表（英文，给店员看）。 */
export function parseSettingsForm(form: FormData): { ok: true; value: SettingsInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const num = (key: string, { min, max, integer }: { min: number; max: number; integer?: boolean }) => {
    const raw = String(form.get(key) ?? "").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      errors.push(`${key} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}`);
      return min;
    }
    return n;
  };
  const expiryRaw = String(form.get("expiryMonths") ?? "").trim();
  const memberTag = String(form.get("memberTag") ?? "").trim();
  if (!memberTag) errors.push("memberTag is required");
  const prefix = String(form.get("redeemCodePrefix") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(prefix)) errors.push("redeemCodePrefix must be 2-12 letters or digits");
  const rounding = String(form.get("redeemRounding") ?? "");
  if (!(REDEEM_ROUNDINGS as string[]).includes(rounding)) errors.push(`redeemRounding must be one of ${REDEEM_ROUNDINGS.join(", ")}`);
  const method = String(form.get("redeemMethod") ?? "");
  if (!(REDEEM_METHODS as string[]).includes(method)) errors.push(`redeemMethod must be one of ${REDEEM_METHODS.join(", ")}`);
  const expiryMode = String(form.get("expiryMode") ?? "off");
  if (!(EXPIRY_MODES as string[]).includes(expiryMode)) errors.push(`expiryMode must be one of ${EXPIRY_MODES.join(", ")}`);
  const storeCreditExpiryRaw = String(form.get("storeCreditExpiryMonths") ?? "").trim();
  const membershipProductTag = String(form.get("membershipProductTag") ?? "").trim();
  if (!membershipProductTag) errors.push("membershipProductTag is required");
  const value: SettingsInput = {
    pointsPerDollar: num("pointsPerDollar", { min: 0, max: 100 }),
    redeemPointsPerDollar: num("redeemPointsPerDollar", { min: 1, max: 100000, integer: true }),
    minRedeemPoints: num("minRedeemPoints", { min: 0, max: 1000000, integer: true }),
    redeemStepPoints: num("redeemStepPoints", { min: 1, max: 1000000, integer: true }),
    excludedProductTypes: splitList(String(form.get("excludedProductTypes") ?? "")),
    excludedTags: splitList(String(form.get("excludedTags") ?? "")),
    earnOnShipping: truthy(form.get("earnOnShipping")),
    earnOnTax: truthy(form.get("earnOnTax")),
    pendingDays: num("pendingDays", { min: 0, max: 365, integer: true }),
    expiryMonths: expiryRaw === "" ? null : num("expiryMonths", { min: 1, max: 120, integer: true }),
    expiryMode: asExpiryMode(expiryMode),
    paidTierMultiplier: num("paidTierMultiplier", { min: 0, max: 100 }),
    earnRequiresMember: truthy(form.get("earnRequiresMember")),
    memberTag,
    membershipProductTag,
    membershipMonths: num("membershipMonths", { min: 1, max: 120, integer: true }),
    excludeDiscountedItems: truthy(form.get("excludeDiscountedItems")),
    redeemMethod: asMethod(method),
    storeCreditExpiryMonths:
      storeCreditExpiryRaw === "" ? null : num("storeCreditExpiryMonths", { min: 1, max: 120, integer: true }),
    redeemAmountIsTaxInclusive: truthy(form.get("redeemAmountIsTaxInclusive")),
    assumedTaxRate: num("assumedTaxRate", { min: 0, max: 0.5 }),
    redeemRounding: asRounding(rounding),
    redeemRequiresMember: truthy(form.get("redeemRequiresMember")),
    redeemCodePrefix: prefix,
    redeemExpiryHours: num("redeemExpiryHours", { min: 1, max: 24 * 90, integer: true }),
    signupBonusPoints: num("signupBonusPoints", { min: 0, max: 100000, integer: true }),
    migrationPointsMultiplier: num("migrationPointsMultiplier", { min: 0, max: 100 }),
    posAllowStoreCredit: truthy(form.get("posAllowStoreCredit")),
    posAllowCartDiscount: truthy(form.get("posAllowCartDiscount")),
    cartDiscountExpiryMinutes: num("cartDiscountExpiryMinutes", { min: 5, max: 24 * 60, integer: true }),
  };
  if (!value.posAllowStoreCredit && !value.posAllowCartDiscount) errors.push("Enable at least one POS redeem option");
  if (value.expiryMode === "inactivity" && value.expiryMonths === null) errors.push("expiryMonths is required when expiryMode is inactivity");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export async function saveLoyaltySettings(shop: string, value: SettingsInput, updatedBy: string) {
  const data = {
    ...value,
    pointsPerDollar: new Prisma.Decimal(value.pointsPerDollar),
    paidTierMultiplier: new Prisma.Decimal(value.paidTierMultiplier),
    assumedTaxRate: new Prisma.Decimal(value.assumedTaxRate),
    migrationPointsMultiplier: new Prisma.Decimal(value.migrationPointsMultiplier),
    updatedBy,
  };
  await prisma.loyaltyConfig.upsert({
    where: { shopDomain: shop },
    create: { shopDomain: shop, ...data },
    update: data,
  });
}

export function tierMultiplier(member: Pick<Member, "tier" | "paidUntil">, settings: LoyaltySettings, at: Date) {
  if (member.tier !== "paid") return 1;
  if (member.paidUntil && member.paidUntil < at) return 1;
  return settings.paidTierMultiplier;
}

// ── 兑换倍数窗口 ─────────────────────────────────────────────────────────────

// 没保存过规则的店先用 Appstle 的「Double Redeem Every Wednesday」：周三（多伦多）×2，只限 POS、只限会员
export const DEFAULT_REDEEM_WINDOWS: RedeemWindowRule[] = [
  {
    id: "default-wednesday",
    label: "Double Redeem Every Wednesday",
    dayOfWeek: 3,
    startHour: null,
    endHour: null,
    timezone: "America/Toronto",
    multiplier: 2,
    channels: ["pos"],
    memberOnly: true,
    active: true,
    minSpendEqualsDiscount: true, // Appstle 周三规则：最低订单金额 = 折扣额
  },
];

export async function getRedeemWindows(shop: string, settings?: Pick<LoyaltySettings, "persisted">) {
  const rows = await prisma.redeemWindow.findMany({ where: { shopDomain: shop }, orderBy: { createdAt: "asc" } });
  const persisted = settings?.persisted ?? (await prisma.loyaltyConfig.count({ where: { shopDomain: shop } })) > 0;
  if (!rows.length && !persisted) return DEFAULT_REDEEM_WINDOWS.map((w) => ({ ...w }));
  return rows.map(
    (r): RedeemWindowRule => ({
      id: r.id,
      label: r.label,
      dayOfWeek: r.dayOfWeek,
      startHour: r.startHour,
      endHour: r.endHour,
      timezone: r.timezone,
      multiplier: Number(r.multiplier.toString()),
      channels: r.channels,
      memberOnly: r.memberOnly,
      active: r.active,
      minSpendEqualsDiscount: r.minSpendEqualsDiscount,
    }),
  );
}

const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** 设置页窗口编辑器提交的 JSON → 校验后的窗口列表。 */
export function parseWindowsJson(raw: string): { ok: true; value: RedeemWindowRule[] } | { ok: false; errors: string[] } {
  let list: unknown;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return { ok: false, errors: ["Redeem windows: invalid data, reload the page"] };
  }
  if (!Array.isArray(list) || list.length > 20) return { ok: false, errors: ["Redeem windows: at most 20 windows"] };
  const errors: string[] = [];
  const hour = (v: unknown, label: string, i: number) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 24) {
      errors.push(`Window ${i + 1}: ${label} must be a whole hour 0-24`);
      return null;
    }
    return n;
  };
  const value = list.map((w: Record<string, unknown>, i): RedeemWindowRule => {
    const dayOfWeek = Number(w.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) errors.push(`Window ${i + 1}: pick a day`);
    const multiplier = Number(w.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10)
      errors.push(`Window ${i + 1}: multiplier must be between 0 and 10`);
    const startHour = hour(w.startHour, "start hour", i);
    const endHour = hour(w.endHour, "end hour", i);
    if (startHour !== null && endHour !== null && endHour <= startHour)
      errors.push(`Window ${i + 1}: end hour must be after start hour`);
    const timezone = String(w.timezone || "America/Toronto");
    if (!isValidTimeZone(timezone)) errors.push(`Window ${i + 1}: unknown time zone`);
    const channels = Array.isArray(w.channels)
      ? Array.from(new Set(w.channels.map(String).filter((c) => (REDEEM_CHANNELS as string[]).includes(c))))
      : [];
    return {
      label: String(w.label ?? "").trim().slice(0, 100) || null,
      dayOfWeek,
      startHour,
      endHour,
      timezone,
      multiplier,
      channels,
      memberOnly: Boolean(w.memberOnly),
      active: w.active === undefined ? true : Boolean(w.active),
      minSpendEqualsDiscount: Boolean(w.minSpendEqualsDiscount),
    };
  });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** 整体替换该店的窗口（店员一次保存整张表）。 */
export async function saveRedeemWindows(shop: string, windows: RedeemWindowRule[]) {
  await prisma.$transaction([
    prisma.redeemWindow.deleteMany({ where: { shopDomain: shop } }),
    prisma.redeemWindow.createMany({
      data: windows.map((w) => ({
        shopDomain: shop,
        label: w.label ?? null,
        dayOfWeek: w.dayOfWeek,
        startHour: w.startHour,
        endHour: w.endHour,
        timezone: w.timezone,
        multiplier: new Prisma.Decimal(w.multiplier),
        channels: w.channels,
        memberOnly: w.memberOnly,
        active: w.active,
        minSpendEqualsDiscount: Boolean(w.minSpendEqualsDiscount),
      })),
    }),
  ]);
}

// ── Admin API（任务里用离线 session；实现在 ./shopAdmin.server.ts）──────────────────

export { getAdminForShop, getOfflineAdmin, type AdminGraphql } from "./shopAdmin.server";
export async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await resp.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Admin GraphQL error: ${JSON.stringify(json.errors).slice(0, 500)}`);
  if (!json.data) throw new Error("Admin GraphQL returned no data");
  return json.data;
}

export const ORDER_FOR_EARN_QUERY = `#graphql
  query LoyaltyOrderForEarn($id: ID!) {
    order(id: $id) {
      id
      name
      test
      email
      processedAt
      taxesIncluded
      discountCodes
      discountApplications(first: 20) {
        nodes {
          ... on DiscountCodeApplication { code }
          ... on ManualDiscountApplication { title }
        }
      }
      customer {
        id
        tags
        firstName
        lastName
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
      }
      shippingLines(first: 10) {
        nodes {
          originalPriceSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          taxLines { priceSet { shopMoney { amount } } }
        }
      }
      lineItems(first: 250) {
        nodes {
          id
          title
          quantity
          isGiftCard
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          taxLines { priceSet { shopMoney { amount } } }
          product { id productType tags }
        }
      }
    }
  }`;

const PRODUCT_INFO_QUERY = `#graphql
  query LoyaltyProductInfo($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id productType tags }
    }
  }`;

/** REST 订单行不带 productType / tags；有排除规则时按商品 ID 批量补上。 */
export async function enrichLinesWithProductInfo(admin: AdminGraphql, lines: EarnLine[]): Promise<EarnLine[]> {
  const ids = Array.from(new Set(lines.map((l) => l.productId).filter((id): id is string => Boolean(id))));
  const info = new Map<string, { productType: string | null; tags: string[] }>();
  for (let i = 0; i < ids.length; i += 100) {
    const data = await gql<{ nodes: Array<{ id: string; productType: string | null; tags: string[] } | null> }>(
      admin,
      PRODUCT_INFO_QUERY,
      { ids: ids.slice(i, i + 100) },
    );
    for (const n of data.nodes) if (n?.id) info.set(n.id, { productType: n.productType, tags: n.tags ?? [] });
  }
  return lines.map((l) => {
    const p = l.productId ? info.get(l.productId) : undefined;
    return p ? { ...l, productType: p.productType, tags: p.tags } : l;
  });
}

const METAFIELDS_SET = `#graphql
  mutation LoyaltyBalanceMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }`;

export const BALANCE_METAFIELD = { namespace: "borderline", key: "points_balance", type: "number_integer" } as const;

/** 把缓存余额镜像到客户 metafield borderline.points_balance（Flow / Klaviyo / 主题直接读）。 */
export async function syncBalanceMetafield(admin: AdminGraphql, memberId: string): Promise<number> {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });
  const data = await gql<{
    metafieldsSet: { userErrors: Array<{ field: string[] | null; message: string; code: string | null }> };
  }>(admin, METAFIELDS_SET, {
    metafields: [{ ownerId: member.shopifyCustomerId, ...BALANCE_METAFIELD, value: String(member.balanceCached) }],
  });
  const errs = data.metafieldsSet.userErrors;
  if (errs.length) throw new Error(`metafieldsSet: ${errs.map((e) => e.message).join("; ")}`);
  return member.balanceCached;
}

// ── 会员 ────────────────────────────────────────────────────────────────────

/** 按 Customer GID upsert；不拿空值覆盖已有资料。payload 带了标签（c.tags 非 null）就同步标签快照。 */
export async function upsertMemberFromCustomer(shop: string, c: OrderCustomer, source: string): Promise<Member> {
  const present: Record<string, string | string[] | null> = Object.fromEntries(
    Object.entries({ email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName }).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  );
  if (c.tags) present.tags = c.tags;
  return prisma.member.upsert({
    where: { shopifyCustomerId: c.gid },
    create: { shopifyCustomerId: c.gid, shopDomain: shop, source, ...present },
    update: present,
  });
}

// ── 流水（只追加）+ 余额缓存：实现在 ./ledger.server.ts ─────────────────────────
export {
  appendLedger,
  insertLedger,
  isUniqueViolation,
  recomputeCaches,
  withMemberLock,
  type LedgerEntryInput,
  type Tx,
} from "./ledger.server";

// ── 店员界面 ────────────────────────────────────────────────────────────────

export async function searchMembers(shop: string, q: string, take = 50) {
  const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const where: Prisma.MemberWhereInput = {
    shopDomain: shop,
    AND: tokens.map((t) => ({
      OR: [
        { email: { contains: t, mode: "insensitive" as const } },
        { phone: { contains: t } },
        { firstName: { contains: t, mode: "insensitive" as const } },
        { lastName: { contains: t, mode: "insensitive" as const } },
        { shopifyCustomerId: { endsWith: `/${t}` } },
      ],
    })),
  };
  return prisma.member.findMany({ where, orderBy: { updatedAt: "desc" }, take });
}

export async function getMemberWithLedger(shop: string, memberId: string, take = 200) {
  return prisma.member.findFirst({
    where: { id: memberId, shopDomain: shop },
    include: {
      ledger: { orderBy: { createdAt: "desc" }, take },
      memberships: { orderBy: { createdAt: "desc" } },
      redemptions: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
}

/** 员工调分：idempotencyKey 来自表单（防重复提交），createdBy = 员工邮箱 / 用户 ID。 */
export async function adjustPoints(params: {
  memberId: string;
  delta: number;
  reason: string;
  staff: string;
  idempotencyKey: string;
}) {
  return appendLedger({
    memberId: params.memberId,
    delta: params.delta,
    type: "adjust",
    referenceType: "staff_adjust",
    referenceId: `staff_adjust:${params.idempotencyKey}`,
    note: params.reason,
    createdBy: params.staff,
  });
}

/** 记账用的员工标识：在线 session（useOnlineTokens）带员工邮箱；万一拿不到才退回 Shopify 用户 ID。 */
export function staffIdentity(
  session: { onlineAccessInfo?: { associated_user?: { email?: string } } },
  sessionToken?: { sub?: string } | null,
): string {
  const email = session.onlineAccessInfo?.associated_user?.email;
  if (email) return email;
  return sessionToken?.sub ? `shopify-user:${sessionToken.sub}` : "staff:unknown";
}
