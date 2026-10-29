// 顾客 / 店员端共用的积分服务：POS 扩展、顾客账户扩展、店面 App Proxy 三条入口都调这里。
// 身份由调用方的鉴权层给出（Shopify 客户 GID），这里不再信任任何别的身份字段。
import type { Member, Membership } from "@prisma/client";

import prisma from "../db.server";
import { isMember } from "../lib/membership";
import { pointsForCents } from "../lib/loyaltyMath";
import { formatCents, quoteRedemption as quotePure, redeemPointOptions, type RedeemChannel } from "../lib/redeemMath";
import { syncMembershipForCustomer } from "./membership.server";
import {
  appendLedger,
  getLoyaltySettings,
  getRedeemWindows,
  gql,
  syncBalanceMetafield,
  type AdminGraphql,
  type LoyaltySettings,
} from "./loyalty.server";
import { getStoreCreditBalanceCents, issueRedemption, type IssueResult, type RedemptionMethod } from "./redemption.server";

export const customerGid = (id: string | number) => {
  const s = String(id).trim();
  return s.startsWith("gid://") ? s : `gid://shopify/Customer/${s.replace(/\D/g, "")}`;
};

type MemberFull = Member & { memberships: Membership[] };

const CUSTOMER_BASICS = `#graphql
  query LoyaltyCustomerBasics($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      tags
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
  }`;

/**
 * 找会员；没有就从 Shopify 建档（任何有客户记录的人都是普通会员，老板 10/29 规则）。
 * createIfMissing=false 时只读（例如商品页估分）。客户在 Shopify 不存在 → null。
 */
export async function ensureMember(
  shop: string,
  gid: string,
  admin: () => Promise<AdminGraphql>,
  opts: { createIfMissing: boolean; source: string },
): Promise<MemberFull | null> {
  const existing = await prisma.member.findUnique({ where: { shopifyCustomerId: gid }, include: { memberships: true } });
  const settings = await getLoyaltySettings(shop);
  const stale = !existing?.membershipSyncedAt || Date.now() - existing.membershipSyncedAt.getTime() > 24 * 60 * 60 * 1000;
  if (existing && !stale) return existing;
  if (!existing && !opts.createIfMissing) return null;
  const a = await admin();
  const data = await gql<{
    customer: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      tags: string[];
      defaultEmailAddress: { emailAddress: string } | null;
      defaultPhoneNumber: { phoneNumber: string } | null;
    } | null;
  }>(a, CUSTOMER_BASICS, { id: gid });
  if (!data.customer) return existing;
  const c = data.customer;
  const member = await prisma.member.upsert({
    where: { shopifyCustomerId: gid },
    create: {
      shopifyCustomerId: gid,
      shopDomain: shop,
      source: opts.source,
      email: c.defaultEmailAddress?.emailAddress ?? null,
      phone: c.defaultPhoneNumber?.phoneNumber ?? null,
      firstName: c.firstName,
      lastName: c.lastName,
      tags: c.tags,
    },
    update: {
      email: c.defaultEmailAddress?.emailAddress ?? undefined,
      phone: c.defaultPhoneNumber?.phoneNumber ?? undefined,
      firstName: c.firstName ?? undefined,
      lastName: c.lastName ?? undefined,
      tags: c.tags,
    },
    include: { memberships: true },
  });
  // 首次建档送分（规则 0 = 不送）
  if (!existing && settings.signupBonusPoints > 0) {
    await appendLedger({
      memberId: member.id,
      delta: settings.signupBonusPoints,
      type: "signup_bonus",
      referenceType: "customer",
      referenceId: `signup:${gid}`,
      note: "Welcome bonus",
      createdBy: "system",
    });
  }
  // 会员资格（标签 / Appstle 合约）
  const synced = await syncMembershipForCustomer(shop, a, gid, {
    memberTag: settings.memberTag,
    createIfMember: false,
    source: opts.source,
  });
  return synced ?? (await prisma.member.findUniqueOrThrow({ where: { id: member.id }, include: { memberships: true } }));
}

export type MemberSummary = {
  memberId: string;
  customerId: string;
  name: string;
  tier: "standard" | "paid";
  isPaidMember: boolean;
  paidUntil: string | null;
  balance: number;
  pending: number;
  storeCreditCents: number | null;
  storeCredit: string | null;
  rules: {
    pointsPerDollar: number;
    paidPointsPerDollar: number;
    redeemPointsPerDollar: number;
    minRedeemPoints: number;
    redeemStepPoints: number;
    redeemMethod: LoyaltySettings["redeemMethod"];
  };
  options: Array<{ points: number; amountCents: number; amount: string; multiplier: number; windowLabel: string | null }>;
  /** POS「抵扣当前购物车」档位（税前金额口径，与折扣码一致） */
  cartOptions: Array<{ points: number; amountCents: number; amount: string; multiplier: number; windowLabel: string | null }>;
  pos: { allowStoreCredit: boolean; allowCartDiscount: boolean; cartDiscountExpiryMinutes: number };
  recent: Array<{ at: string; type: string; delta: number; note: string | null; orderName: string | null }>;
};

export async function memberSummary(
  shop: string,
  member: MemberFull,
  channel: RedeemChannel,
  admin: (() => Promise<AdminGraphql>) | null,
  at = new Date(),
): Promise<MemberSummary> {
  const settings = await getLoyaltySettings(shop);
  const windows = await getRedeemWindows(shop, settings);
  const paid = isMember(member, at, settings.memberTag) || (member.tier === "paid" && (!member.paidUntil || member.paidUntil > at));
  const rules = {
    redeemMethod: settings.redeemMethod,
    redeemPointsPerDollar: settings.redeemPointsPerDollar,
    minRedeemPoints: settings.minRedeemPoints,
    redeemStepPoints: settings.redeemStepPoints,
    redeemAmountIsTaxInclusive: settings.redeemAmountIsTaxInclusive,
    assumedTaxRate: settings.assumedTaxRate,
    redeemRounding: settings.redeemRounding,
    redeemRequiresMember: settings.redeemRequiresMember,
  };
  const quoteWith = (r: typeof rules) =>
    redeemPointOptions(member.balanceCached, r, 12).map((points) => {
      const q = quotePure({ points, channel, at, isMember: paid, balance: member.balanceCached }, r, windows);
      return {
        points,
        amountCents: q.amountCents,
        amount: formatCents(q.amountCents),
        multiplier: q.multiplier,
        windowLabel: q.window?.label ?? null,
      };
    });
  const options = quoteWith(rules);
  const cartOptions = channel === "pos" ? quoteWith({ ...rules, redeemMethod: "discount_code" }) : [];
  let storeCreditCents: number | null = null;
  if (admin && settings.redeemMethod === "store_credit") {
    try {
      storeCreditCents = await getStoreCreditBalanceCents(await admin(), member.shopifyCustomerId);
    } catch (e) {
      console.warn("[loyalty] store credit balance lookup failed:", (e as Error).message);
    }
  }
  const recent = await prisma.pointsLedger.findMany({
    where: { memberId: member.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { createdAt: true, type: true, delta: true, note: true, orderName: true },
  });
  return {
    memberId: member.id,
    customerId: member.shopifyCustomerId,
    name: [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email || "Customer",
    tier: paid ? "paid" : "standard",
    isPaidMember: paid,
    paidUntil: member.paidUntil?.toISOString() ?? null,
    balance: member.balanceCached,
    pending: member.pendingCached,
    storeCreditCents,
    storeCredit: storeCreditCents === null ? null : formatCents(storeCreditCents),
    rules: {
      pointsPerDollar: settings.pointsPerDollar,
      paidPointsPerDollar: settings.pointsPerDollar * settings.paidTierMultiplier,
      redeemPointsPerDollar: settings.redeemPointsPerDollar,
      minRedeemPoints: settings.minRedeemPoints,
      redeemStepPoints: settings.redeemStepPoints,
      redeemMethod: settings.redeemMethod,
    },
    options,
    cartOptions,
    pos: {
      allowStoreCredit: settings.posAllowStoreCredit && settings.redeemMethod === "store_credit",
      allowCartDiscount: settings.posAllowCartDiscount,
      cartDiscountExpiryMinutes: settings.cartDiscountExpiryMinutes,
    },
    recent: recent.map((r) => ({
      at: r.createdAt.toISOString(),
      type: r.type,
      delta: r.delta,
      note: r.note,
      orderName: r.orderName,
    })),
  };
}

/** 商品页 / 购物车估分："这单能赚多少"。只按小计，不看排除规则（页面提示用）。 */
export async function estimatePoints(shop: string, cents: number) {
  const settings = await getLoyaltySettings(shop);
  const safe = Math.max(0, Math.floor(cents));
  return {
    standard: pointsForCents(safe, settings.pointsPerDollar, 1),
    paid: pointsForCents(safe, settings.pointsPerDollar, settings.paidTierMultiplier),
    pointsPerDollar: settings.pointsPerDollar,
    paidPointsPerDollar: settings.pointsPerDollar * settings.paidTierMultiplier,
    redeemPointsPerDollar: settings.redeemPointsPerDollar,
    minRedeemPoints: settings.minRedeemPoints,
  };
}

/** 顾客 / 店员发起兑换。idempotencyKey 由前端生成（同一次点击重放只兑一次）。 */
export async function redeemForMember(params: {
  shop: string;
  member: MemberFull;
  points: number;
  channel: RedeemChannel;
  issuedBy: string;
  idempotencyKey: string | null;
  admin: () => Promise<AdminGraphql>;
  method?: RedemptionMethod;
  maxAmountCents?: number | null;
}): Promise<IssueResult> {
  const res = await issueRedemption(
    {
      memberId: params.member.id,
      points: params.points,
      channel: params.channel,
      issuedBy: params.issuedBy,
      idempotencyKey: params.idempotencyKey,
      method: params.method,
      maxAmountCents: params.maxAmountCents,
    },
    { getAdmin: params.admin },
  );
  // 余额 metafield 同步（失败不影响兑换结果）
  try {
    await syncBalanceMetafield(await params.admin(), params.member.id);
  } catch (e) {
    console.warn("[loyalty] balance metafield sync after redeem failed:", (e as Error).message);
  }
  return res;
}

export const KEY_RE = /^[0-9a-zA-Z_-]{8,64}$/;
