// 积分兑换（老板 2026-10-29 定：1000 分 = $10 Store Credit）：
//   store_credit（默认）：报价 → 扣分 + 建 Redemption（同一事务）→ storeCreditAccountCredit 发到顾客的 Shopify Store Credit
//                        （线上结账、POS 收款都原生可用，不用码）→ 状态 credited；失败就退回（redeem_release）。
//   discount_code（备用）：同上，但发一次性专属折扣码。
// 店员撤销 Store Credit：reverseStoreCredit → storeCreditAccountDebit 扣回 + 退分（credited → cancelled）。
// 核销：loyalty.earn 看到订单用了我们的码 → used。过期：sweep 把过期未用的码停用 + 退分。
// 幂等：
//   - 店员表单键 Redemption.idempotencyKey 唯一：同一次提交重放只发一张码
//   - 扣分 ledger (redeem, redemption:<id>) / 退分 ledger (redeem_release, redemption:<id>) 各最多一条
//   - 状态只从 issued 往前走（issued → used | cancelled | expired），用 updateMany where status = issued 守住
import { randomBytes } from "node:crypto";
import type { Redemption } from "@prisma/client";

import prisma from "../db.server";
import { isMember } from "../lib/membership";
import {
  formatCents,
  quoteRedemption as quotePure,
  redemptionDiscountInput,
  type RedeemChannel,
  type RedemptionQuote,
} from "../lib/redeemMath";
import { insertLedger, withMemberLock } from "./ledger.server";
import { getLoyaltySettings, getRedeemWindows, gql, type AdminGraphql, type LoyaltySettings } from "./loyalty.server";

const HOUR_MS = 60 * 60 * 1000;
const ORPHAN_MS = 15 * 60 * 1000; // 扣了分但 15 分钟还没拿到折扣码 ID = 进程中途挂了，退分

export type RedemptionDeps = { getAdmin: (shop: string) => Promise<AdminGraphql> };

// ── 报价 ────────────────────────────────────────────────────────────────────

async function loadContext(memberId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { memberships: true } });
  if (!member) throw new Error("Member not found");
  const settings = await getLoyaltySettings(member.shopDomain);
  const windows = await getRedeemWindows(member.shopDomain, settings);
  return { member, settings, windows };
}

const ruleSubset = (s: LoyaltySettings) => ({
  redeemMethod: s.redeemMethod,
  redeemPointsPerDollar: s.redeemPointsPerDollar,
  minRedeemPoints: s.minRedeemPoints,
  redeemStepPoints: s.redeemStepPoints,
  redeemAmountIsTaxInclusive: s.redeemAmountIsTaxInclusive,
  assumedTaxRate: s.assumedTaxRate,
  redeemRounding: s.redeemRounding,
  redeemRequiresMember: s.redeemRequiresMember,
});

/** 服务端报价（按库里的余额、会员资格、窗口）。 */
export async function quoteRedemption(params: {
  memberId: string;
  points: number;
  channel: RedeemChannel;
  at?: Date;
}): Promise<RedemptionQuote> {
  const { member, settings, windows } = await loadContext(params.memberId);
  const at = params.at ?? new Date();
  return quotePure(
    {
      points: params.points,
      channel: params.channel,
      at,
      isMember: isMember(member, at, settings.memberTag),
      balance: member.balanceCached,
    },
    ruleSubset(settings),
    windows,
  );
}

// ── 发码 ────────────────────────────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 0/O/1/I，方便门店念码手输
const randomSuffix = (n = 4) =>
  Array.from(randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

/** POINTS-500-K3D9QX-7FQ2：前缀-积分-会员短号-随机 4 位（Shopify 折扣码全店唯一，同一人同额第二次也不能撞）。 */
export function buildRedemptionCode(prefix: string, points: number, memberId: string, suffix = randomSuffix()) {
  const short = memberId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
  return `${prefix}-${points}-${short}-${suffix}`;
}

const DISCOUNT_CREATE = `#graphql
  mutation LoyaltyRedeemCodeCreate($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

const DISCOUNT_DEACTIVATE = `#graphql
  mutation LoyaltyRedeemCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }`;

const DISCOUNT_USAGE = `#graphql
  query LoyaltyRedeemCodeUsage($id: ID!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount { ... on DiscountCodeBasic { asyncUsageCount status } }
    }
  }`;

const STORE_CREDIT_CREDIT = `#graphql
  mutation LoyaltyStoreCreditCredit($id: ID!, $input: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $input) {
      storeCreditAccountTransaction { id account { id balance { amount currencyCode } } }
      userErrors { field message code }
    }
  }`;

const STORE_CREDIT_DEBIT = `#graphql
  mutation LoyaltyStoreCreditDebit($id: ID!, $input: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $input) {
      storeCreditAccountTransaction { id account { id balance { amount currencyCode } } }
      userErrors { field message code }
    }
  }`;

const STORE_CREDIT_BALANCE = `#graphql
  query LoyaltyStoreCreditBalance($id: ID!) {
    customer(id: $id) {
      storeCreditAccounts(first: 5) { nodes { id balance { amount currencyCode } } }
    }
  }`;

type UserError = { field: string[] | null; message: string; code: string | null };
type StoreCreditTx = { id: string; account: { id: string; balance: { amount: string; currencyCode: string } } };

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** 顾客 Store Credit 余额（分）。没有账户 = 0。 */
export async function getStoreCreditBalanceCents(admin: AdminGraphql, customerGid: string, currency = "CAD") {
  const data = await gql<{ customer: { storeCreditAccounts: { nodes: StoreCreditTx["account"][] } } | null }>(
    admin,
    STORE_CREDIT_BALANCE,
    { id: customerGid },
  );
  const acct = data.customer?.storeCreditAccounts.nodes.find((a) => a.balance.currencyCode === currency);
  return acct ? Math.round(Number(acct.balance.amount) * 100) : 0;
}

export type IssueResult =
  | { ok: true; applied: boolean; redemption: Redemption; quote: RedemptionQuote | null }
  | { ok: false; error: string; quote: RedemptionQuote | null; redemption?: Redemption };

/** 发码输入（discountCodeBasicCreate）：纯函数在 app/lib/redeemMath.ts，单测覆盖。 */
export const discountInput = redemptionDiscountInput;

export type RedemptionMethod = "store_credit" | "discount_code" | "cart_discount";

const MINUTE_MS = 60 * 1000;

export async function issueRedemption(
  params: {
    memberId: string;
    points: number;
    channel: RedeemChannel;
    issuedBy: string;
    idempotencyKey?: string | null;
    at?: Date;
    /** 不传 = 规则里的 redeemMethod；POS 当场抵扣传 cart_discount */
    method?: RedemptionMethod;
    /** cart_discount：抵扣额不能超过购物车小计（前端传来，后端再守一次） */
    maxAmountCents?: number | null;
  },
  deps: RedemptionDeps,
): Promise<IssueResult> {
  if (params.idempotencyKey) {
    const prior = await prisma.redemption.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (prior) return prior.status === "cancelled"
      ? { ok: false, error: "This redemption already failed; reload and try again", quote: null, redemption: prior }
      : { ok: true, applied: false, redemption: prior, quote: null };
  }
  const { member, settings, windows } = await loadContext(params.memberId);
  const now = params.at ?? new Date();
  const method: RedemptionMethod = params.method ?? settings.redeemMethod;
  if (method === "cart_discount" && params.channel !== "pos") {
    return { ok: false, error: "Cart discounts can only be applied at POS", quote: null };
  }
  // cart_discount 的金额口径与折扣码一致（税前抵扣）
  const quoteRules = { ...ruleSubset(settings), redeemMethod: method === "store_credit" ? ("store_credit" as const) : ("discount_code" as const) };

  // 1) 锁会员行：按最新余额报价 → 建 Redemption + 扣分
  let created: { redemption: Redemption; quote: RedemptionQuote };
  try {
    created = await withMemberLock(member.id, async (tx) => {
      const fresh = await tx.member.findUniqueOrThrow({ where: { id: member.id } });
      const quote = quotePure(
        {
          points: params.points,
          channel: params.channel,
          at: now,
          isMember: isMember(member, now, settings.memberTag),
          balance: fresh.balanceCached,
        },
        quoteRules,
        windows,
      );
      if (!quote.ok) throw new QuoteError(quote);
      if (method === "cart_discount" && params.maxAmountCents != null && quote.amountCents > params.maxAmountCents) {
        throw new QuoteError({ ...quote, ok: false, error: `Discount ${formatCents(quote.amountCents)} is more than the cart subtotal ${formatCents(params.maxAmountCents)}` });
      }
      const storeCredit = method === "store_credit";
      const redemption = await tx.redemption.create({
        data: {
          memberId: member.id,
          points: params.points,
          amountCents: quote.amountCents,
          currency: "CAD",
          method,
          // cart_discount：这个字符串就是 POS 自定义折扣的标题，订单上会出现在 discount_applications[].title → 核销靠它
          discountCode: storeCredit ? null : buildRedemptionCode(settings.redeemCodePrefix, params.points, member.id),
          status: "issued",
          channel: params.channel,
          issuedBy: params.issuedBy,
          expiresAt: storeCredit
            ? settings.storeCreditExpiryMonths
              ? new Date(now.getTime() + settings.storeCreditExpiryMonths * MONTH_MS)
              : null
            : method === "cart_discount"
              ? new Date(now.getTime() + settings.cartDiscountExpiryMinutes * MINUTE_MS)
              : new Date(now.getTime() + settings.redeemExpiryHours * HOUR_MS),
          idempotencyKey: params.idempotencyKey ?? null,
          meta: {
            multiplier: quote.multiplier,
            window: quote.window,
            faceValueCents: quote.faceValueCents,
            taxRate: quote.taxRate,
            rounding: quote.rounding,
            minSubtotalCents: quote.minSubtotalCents,
          },
        },
      });
      await insertLedger(tx, {
        memberId: member.id,
        delta: -params.points,
        type: "redeem",
        referenceType: "redemption",
        referenceId: `redemption:${redemption.id}`,
        note: storeCredit
          ? `${formatCents(quote.amountCents)} store credit (${params.channel}${quote.multiplier !== 1 ? `, x${quote.multiplier}` : ""})`
          : method === "cart_discount"
            ? `${formatCents(quote.amountCents)} off the POS cart (${redemption.discountCode}${quote.multiplier !== 1 ? `, x${quote.multiplier}` : ""})`
            : `${redemption.discountCode} (${formatCents(quote.amountCents)} off, ${params.channel}${quote.multiplier !== 1 ? `, x${quote.multiplier}` : ""})`,
        createdBy: params.issuedBy,
      });
      return { redemption, quote };
    });
  } catch (e) {
    if (e instanceof QuoteError) return { ok: false, error: e.quote.error ?? "Cannot redeem", quote: e.quote };
    // 表单键并发重放撞唯一约束：返回那一张
    if (params.idempotencyKey) {
      const prior = await prisma.redemption.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
      if (prior) return { ok: true, applied: false, redemption: prior, quote: null };
    }
    throw e;
  }

  const { redemption, quote } = created;

  // 2c) POS 当场抵扣：不用调 Shopify，扩展拿到 code（=折扣标题）后自己 applyCartDiscount；成交 → orders/paid 核销，没成交 → 到期退分
  if (redemption.method === "cart_discount") return { ok: true, applied: true, redemption, quote };

  // 2a) Store Credit：发到顾客账户；失败 → 退分 + cancelled
  if (redemption.method === "store_credit") {
    try {
      const admin = await deps.getAdmin(member.shopDomain);
      const data = await gql<{
        storeCreditAccountCredit: { storeCreditAccountTransaction: StoreCreditTx | null; userErrors: UserError[] };
      }>(admin, STORE_CREDIT_CREDIT, {
        id: member.shopifyCustomerId,
        input: {
          creditAmount: { amount: dollars(redemption.amountCents), currencyCode: redemption.currency },
          ...(redemption.expiresAt ? { expiresAt: redemption.expiresAt.toISOString() } : {}),
          notify: true, // Shopify 自己给顾客发「您收到了 Store Credit」邮件
        },
      });
      const res = data.storeCreditAccountCredit;
      if (res.userErrors.length || !res.storeCreditAccountTransaction) {
        throw new Error(`storeCreditAccountCredit: ${res.userErrors.map((u) => u.message).join("; ") || "no transaction returned"}`);
      }
      const updated = await prisma.redemption.update({
        where: { id: redemption.id },
        data: {
          status: "credited",
          storeCreditTransactionId: res.storeCreditAccountTransaction.id,
          storeCreditAccountId: res.storeCreditAccountTransaction.account.id,
          meta: { ...(redemption.meta as object), storeCreditBalanceAfter: res.storeCreditAccountTransaction.account.balance.amount },
        },
      });
      return { ok: true, applied: true, redemption: updated, quote };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      console.error(`[loyalty] redemption ${redemption.id} store credit failed, releasing points:`, message);
      await releaseRedemption(redemption.id, "cancelled", "system", `Store credit not issued: ${message.slice(0, 200)}`);
      return { ok: false, error: `Shopify rejected the store credit, points were returned: ${message.slice(0, 200)}`, quote };
    }
  }

  // 2b) 折扣码；失败 → 退分 + cancelled
  try {
    const admin = await deps.getAdmin(member.shopDomain);
    const data = await gql<{
      discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: UserError[] };
    }>(admin, DISCOUNT_CREATE, {
      input: discountInput(
        {
          code: redemption.discountCode!,
          amountCents: redemption.amountCents,
          expiresAt: redemption.expiresAt!,
          minSubtotalCents: quote.minSubtotalCents,
        },
        member.shopifyCustomerId,
        now,
      ),
    });
    const res = data.discountCodeBasicCreate;
    if (res.userErrors.length || !res.codeDiscountNode) {
      throw new Error(`discountCodeBasicCreate: ${res.userErrors.map((u) => u.message).join("; ") || "no discount returned"}`);
    }
    const updated = await prisma.redemption.update({
      where: { id: redemption.id },
      data: { discountCodeId: res.codeDiscountNode.id },
    });
    return { ok: true, applied: true, redemption: updated, quote };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error(`[loyalty] redemption ${redemption.id} discount create failed, releasing points:`, message);
    await releaseRedemption(redemption.id, "cancelled", "system", `Shopify discount not created: ${message.slice(0, 200)}`);
    return { ok: false, error: `Shopify rejected the discount, points were returned: ${message.slice(0, 200)}`, quote };
  }
}

class QuoteError extends Error {
  constructor(public quote: RedemptionQuote) {
    super(quote.error ?? "quote failed");
  }
}

/** 退分：issued → cancelled | expired，写 redeem_release（+points）。已不是 issued 就什么都不做。 */
export async function releaseRedemption(
  redemptionId: string,
  status: "cancelled" | "expired",
  by: string,
  note: string,
): Promise<boolean> {
  const r = await prisma.redemption.findUnique({ where: { id: redemptionId } });
  if (!r || r.status !== "issued") return false;
  return withMemberLock(r.memberId, async (tx) => {
    const moved = await tx.redemption.updateMany({ where: { id: r.id, status: "issued" }, data: { status } });
    if (moved.count === 0) return false;
    const redeem = await tx.pointsLedger.findUnique({
      where: { type_referenceId: { type: "redeem", referenceId: `redemption:${r.id}` } },
    });
    if (redeem) {
      await insertLedger(tx, {
        memberId: r.memberId,
        delta: -redeem.delta,
        type: "redeem_release",
        referenceType: "redemption",
        referenceId: `redemption:${r.id}`,
        note: `${r.discountCode ?? r.id}: ${note}`,
        createdBy: by,
      });
    }
    return true;
  });
}

// ── 撤销 Store Credit（店员操作）────────────────────────────────────────────

/**
 * credited → cancelled：从顾客 Store Credit 扣回同额（余额不够 Shopify 会拒，原样报错）+ 退分（redeem_release）。
 * 幂等：状态只从 credited 走一次；并发第二次直接返回 false。
 */
export async function reverseStoreCredit(
  redemptionId: string,
  by: string,
  note: string,
  deps: RedemptionDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await prisma.redemption.findUnique({ where: { id: redemptionId }, include: { member: true } });
  if (!r || r.method !== "store_credit") return { ok: false, error: "Not a store credit redemption" };
  if (r.status !== "credited") return { ok: false, error: `Cannot reverse a redemption in status ${r.status}` };
  const admin = await deps.getAdmin(r.member.shopDomain);
  const data = await gql<{
    storeCreditAccountDebit: { storeCreditAccountTransaction: StoreCreditTx | null; userErrors: UserError[] };
  }>(admin, STORE_CREDIT_DEBIT, {
    id: r.storeCreditAccountId ?? r.member.shopifyCustomerId,
    input: { debitAmount: { amount: dollars(r.amountCents), currencyCode: r.currency } },
  });
  const res = data.storeCreditAccountDebit;
  if (res.userErrors.length || !res.storeCreditAccountTransaction) {
    return { ok: false, error: res.userErrors.map((u) => u.message).join("; ") || "Shopify returned no transaction" };
  }
  const txId = res.storeCreditAccountTransaction.id;
  await withMemberLock(r.memberId, async (tx) => {
    const moved = await tx.redemption.updateMany({
      where: { id: r.id, status: "credited" },
      data: { status: "cancelled", storeCreditReversalId: txId },
    });
    if (moved.count === 0) return;
    await insertLedger(tx, {
      memberId: r.memberId,
      delta: r.points,
      type: "redeem_release",
      referenceType: "redemption",
      referenceId: `redemption:${r.id}`,
      note: `Store credit ${formatCents(r.amountCents)} reversed: ${note}`,
      createdBy: by,
    });
  });
  return { ok: true };
}

// ── 核销 ────────────────────────────────────────────────────────────────────

/**
 * 订单上的码（discount_codes / discount_applications 的 code 或 title）里有我们发的 → used。
 * 码已因过期 / 失败退了分（cancelled / expired）却仍被用了：记日志，交给店员调分（不自动再扣）。
 */
export async function markRedemptionUsed(order: { orderGid: string; discountCodes: string[] }) {
  const codes = Array.from(new Set(order.discountCodes.map((c) => c.trim()).filter(Boolean)));
  if (!codes.length) return { used: 0, late: 0 };
  const matches = await prisma.redemption.findMany({
    where: { discountCode: { in: codes, mode: "insensitive" } },
    select: { id: true, status: true, orderId: true, discountCode: true },
  });
  let used = 0;
  let late = 0;
  for (const m of matches) {
    if (m.status === "issued") {
      const r = await prisma.redemption.updateMany({
        where: { id: m.id, status: "issued" },
        data: { status: "used", orderId: order.orderGid },
      });
      used += r.count;
    } else if (m.status !== "used") {
      late++;
      console.warn(`[loyalty] redemption ${m.id} (${m.status}) code used on ${order.orderGid}; points were already returned`);
    }
  }
  return { used, late };
}

// ── 过期 / 孤儿清理（sweep 调用）────────────────────────────────────────────

export async function sweepRedemptions(deps: RedemptionDeps, now = new Date()) {
  const due = await prisma.redemption.findMany({
    where: {
      status: "issued",
      OR: [
        { expiresAt: { lt: now } },
        { discountCodeId: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_MS) } },
      ],
    },
    include: { member: { select: { shopDomain: true } } },
    take: 200,
  });
  const out = { expired: 0, orphans: 0, usedLate: 0, errors: 0 };
  const released: Array<{ shop: string; memberId: string }> = [];
  for (const r of due) {
    try {
      if (r.method === "cart_discount") {
        // 抵扣了购物车但一直没成交：到期退分（成交的话 orders/paid 早就把它标成 used 了）
        if (await releaseRedemption(r.id, "expired", "system", "cart discount not used before the hold expired")) {
          out.expired++;
          released.push({ shop: r.member.shopDomain, memberId: r.memberId });
        }
        continue;
      }
      if (r.method === "store_credit") {
        // 还停在 issued = 扣了分但 Store Credit 没确认到账（进程中途挂了）：退分
        if (await releaseRedemption(r.id, "cancelled", "system", "store credit was never confirmed")) {
          out.orphans++;
          released.push({ shop: r.member.shopDomain, memberId: r.memberId });
        }
        continue;
      }
      if (!r.discountCodeId) {
        if (await releaseRedemption(r.id, "cancelled", "system", "discount code was never created")) {
          out.orphans++;
          released.push({ shop: r.member.shopDomain, memberId: r.memberId });
        }
        continue;
      }
      const admin = await deps.getAdmin(r.member.shopDomain);
      // 码可能刚被用、orders/paid 还没处理到：用过就记 used，不退分
      const usage = await gql<{ codeDiscountNode: { codeDiscount: { asyncUsageCount?: number } | null } | null }>(
        admin,
        DISCOUNT_USAGE,
        { id: r.discountCodeId },
      );
      if ((usage.codeDiscountNode?.codeDiscount?.asyncUsageCount ?? 0) > 0) {
        await prisma.redemption.updateMany({ where: { id: r.id, status: "issued" }, data: { status: "used" } });
        out.usedLate++;
        continue;
      }
      if (usage.codeDiscountNode) {
        const d = await gql<{ discountCodeDeactivate: { userErrors: UserError[] } }>(admin, DISCOUNT_DEACTIVATE, {
          id: r.discountCodeId,
        });
        const errs = d.discountCodeDeactivate.userErrors;
        if (errs.length) throw new Error(`discountCodeDeactivate: ${errs.map((u) => u.message).join("; ")}`);
      }
      if (await releaseRedemption(r.id, "expired", "system", "expired unused")) {
        out.expired++;
        released.push({ shop: r.member.shopDomain, memberId: r.memberId });
      }
    } catch (e) {
      out.errors++;
      console.error(`[loyalty] redemption sweep ${r.id} failed:`, (e as Error).message);
    }
  }
  return { ...out, released };
}
