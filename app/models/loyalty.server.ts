// 会员积分服务层：会员 upsert、只追加流水、余额缓存、客户 metafield 镜像、规则读写、员工调分。
// 计分公式在 app/lib/loyaltyMath.ts（纯函数）；这里只管 I/O。
import { Prisma, type Member, type PointsLedger } from "@prisma/client";

import prisma from "../db.server";
import { sessionStorage, unauthenticated } from "../shopify.server";
import type { EarnLine } from "../lib/loyaltyMath";
import type { OrderCustomer } from "../lib/shopifyPayload";

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
  paidTierMultiplier: number;
  updatedBy: string | null;
  updatedAt: string | null;
  persisted: boolean; // false = 库里还没有这一行，用的是下面的默认值
};

// 默认值只是占位，正式规则等老板拍板（方案 §2.5）后在设置页改
export const DEFAULT_SETTINGS: LoyaltySettings = {
  pointsPerDollar: 1,
  redeemPointsPerDollar: 100,
  minRedeemPoints: 500,
  redeemStepPoints: 100,
  excludedProductTypes: [],
  excludedTags: [],
  earnOnShipping: false,
  earnOnTax: false,
  pendingDays: 0,
  expiryMonths: null,
  paidTierMultiplier: 1,
  updatedBy: null,
  updatedAt: null,
  persisted: false,
};

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
    paidTierMultiplier: Number(row.paidTierMultiplier.toString()),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
    persisted: true,
  };
}

export type SettingsInput = Omit<LoyaltySettings, "updatedBy" | "updatedAt" | "persisted">;

const splitList = (v: string) =>
  Array.from(new Set(v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)));

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
  const value: SettingsInput = {
    pointsPerDollar: num("pointsPerDollar", { min: 0, max: 100 }),
    redeemPointsPerDollar: num("redeemPointsPerDollar", { min: 1, max: 100000, integer: true }),
    minRedeemPoints: num("minRedeemPoints", { min: 0, max: 1000000, integer: true }),
    redeemStepPoints: num("redeemStepPoints", { min: 1, max: 1000000, integer: true }),
    excludedProductTypes: splitList(String(form.get("excludedProductTypes") ?? "")),
    excludedTags: splitList(String(form.get("excludedTags") ?? "")),
    earnOnShipping: form.get("earnOnShipping") === "on" || form.get("earnOnShipping") === "true",
    earnOnTax: form.get("earnOnTax") === "on" || form.get("earnOnTax") === "true",
    pendingDays: num("pendingDays", { min: 0, max: 365, integer: true }),
    expiryMonths: expiryRaw === "" ? null : num("expiryMonths", { min: 1, max: 120, integer: true }),
    paidTierMultiplier: num("paidTierMultiplier", { min: 0, max: 10 }),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export async function saveLoyaltySettings(shop: string, value: SettingsInput, updatedBy: string) {
  const data = {
    ...value,
    pointsPerDollar: new Prisma.Decimal(value.pointsPerDollar),
    paidTierMultiplier: new Prisma.Decimal(value.paidTierMultiplier),
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

// ── Admin API（任务里用离线 session）──────────────────────────────────────────

export type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/** 任务里拿 Admin 客户端：先确认有离线 session，再交给库（会自动刷新过期的离线 token）。 */
export async function getAdminForShop(shop: string): Promise<AdminGraphql> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (!sessions.some((s) => !s.isOnline)) {
    throw new Error(`No offline session stored for ${shop}; open the app once in Shopify admin`);
  }
  const { admin } = await unauthenticated.admin(shop);
  return admin as unknown as AdminGraphql;
}

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
      customer {
        id
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

/** 按 Customer GID upsert；不拿空值覆盖已有资料。 */
export async function upsertMemberFromCustomer(shop: string, c: OrderCustomer, source: string): Promise<Member> {
  const present = Object.fromEntries(
    Object.entries({ email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName }).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  );
  return prisma.member.upsert({
    where: { shopifyCustomerId: c.gid },
    create: { shopifyCustomerId: c.gid, shopDomain: shop, source, ...present },
    update: present,
  });
}

// ── 流水（只追加）+ 余额缓存 ─────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

export type LedgerEntryInput = {
  memberId: string;
  delta: number;
  type: "earn" | "redeem" | "redeem_release" | "refund_reverse" | "adjust" | "expire" | "migrate";
  referenceType?: string | null;
  referenceId?: string | null;
  orderId?: string | null;
  orderName?: string | null;
  note?: string | null;
  meta?: Prisma.InputJsonValue;
  availableAt?: Date;
  createdBy: string;
};

/** 同一会员的记账串行化：事务里先 SELECT … FOR UPDATE 锁住会员行。 */
export async function withMemberLock<T>(memberId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`;
    return fn(tx);
  });
}

export async function recomputeCaches(tx: Tx, memberId: string): Promise<Member> {
  const now = new Date();
  const available = await tx.pointsLedger.aggregate({
    where: { memberId, availableAt: { lte: now } },
    _sum: { delta: true },
  });
  const pending = await tx.pointsLedger.aggregate({
    where: { memberId, availableAt: { gt: now } },
    _sum: { delta: true },
  });
  return tx.member.update({
    where: { id: memberId },
    data: { balanceCached: available._sum.delta ?? 0, pendingCached: pending._sum.delta ?? 0 },
  });
}

/** 在已加锁的事务里写一条流水。幂等：(type, referenceId) 已存在就不写，返回 applied=false。 */
export async function insertLedger(
  tx: Tx,
  entry: LedgerEntryInput,
): Promise<{ applied: boolean; row: PointsLedger | null; member: Member }> {
  if (entry.referenceId) {
    const existing = await tx.pointsLedger.findUnique({
      where: { type_referenceId: { type: entry.type, referenceId: entry.referenceId } },
    });
    if (existing) {
      return { applied: false, row: existing, member: await tx.member.findUniqueOrThrow({ where: { id: entry.memberId } }) };
    }
  }
  const row = await tx.pointsLedger.create({
    data: {
      memberId: entry.memberId,
      delta: entry.delta || 0, // 避免 -0
      type: entry.type,
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      orderId: entry.orderId ?? null,
      orderName: entry.orderName ?? null,
      note: entry.note ?? null,
      meta: entry.meta,
      availableAt: entry.availableAt ?? new Date(),
      createdBy: entry.createdBy,
    },
  });
  const member = await recomputeCaches(tx, entry.memberId);
  return { applied: true, row, member };
}

export const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** 加锁 + 写一条流水 + 重算缓存。并发下撞唯一约束也当作「已经写过」。 */
export async function appendLedger(entry: LedgerEntryInput) {
  try {
    return await withMemberLock(entry.memberId, (tx) => insertLedger(tx, entry));
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { applied: false, row: null, member: await prisma.member.findUniqueOrThrow({ where: { id: entry.memberId } }) };
    }
    throw e;
  }
}

/** 订单用了我们发的积分码 → 核销置 used（第一版兑分还没上线，先把挂钩留好）。 */
export async function markRedemptionsUsed(codes: string[], orderGid: string) {
  if (!codes.length) return 0;
  const res = await prisma.redemption.updateMany({
    where: { status: "issued", discountCode: { in: codes, mode: "insensitive" } },
    data: { status: "used", orderId: orderGid },
  });
  return res.count;
}

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
    include: { ledger: { orderBy: { createdAt: "desc" }, take } },
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

/** 记账用的员工标识：在线 session 有邮箱就用邮箱；本应用默认离线 token，没有邮箱时用 Shopify 用户 ID。 */
export function staffIdentity(
  session: { onlineAccessInfo?: { associated_user?: { email?: string } } },
  sessionToken?: { sub?: string } | null,
): string {
  const email = session.onlineAccessInfo?.associated_user?.email;
  if (email) return email;
  return sessionToken?.sub ? `shopify-user:${sessionToken.sub}` : "staff:unknown";
}
