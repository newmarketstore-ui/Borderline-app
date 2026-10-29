// 积分计算纯函数：不碰数据库、不调 API，方便单测。
// 金额一律用「分」（整数，店铺币种 CAD），积分一律向下取整到整数。
// 小数系数（每 $1 几分、付费会员倍数）放大 10^4 后用 BigInt 算，避免浮点误差（0.1 + 0.2 之类）。

const SCALE = 10_000n;

export type EarnLine = {
  lineId: string; // 订单行 GID（gid://shopify/LineItem/…）
  productId?: string | null;
  title?: string | null; // 行标题（只用来判断要不要去补商品标签，不参与计分）
  productType?: string | null;
  tags?: string[];
  giftCard: boolean;
  quantity: number;
  unitPriceCents: number; // 原单价
  discountCents: number; // 该行所有折扣分摊合计（行折扣 + 订单级折扣分摊）
  taxCents: number; // 该行税额
};

export type EarnOrderInput = {
  lines: EarnLine[];
  shippingCents: number; // 运费原价合计
  shippingDiscountCents: number;
  shippingTaxCents: number;
  taxesIncluded: boolean; // 价格是否含税（加拿大店一般 false）
};

export type EarnRules = {
  pointsPerDollar: number;
  excludedProductTypes: string[];
  excludedTags: string[];
  earnOnShipping: boolean;
  earnOnTax: boolean;
  tierMultiplier: number; // standard = 1；paid = LoyaltyConfig.paidTierMultiplier
  // 有任何折扣分摊（行折扣或订单级折扣分摊到该行，包括我们自己的积分码）的行整行不计分（Appstle disablePointsForDiscountedProduct）
  excludeDiscountedItems?: boolean;
};

export type ExclusionReason = "gift_card" | "product_type" | "tag" | "discounted" | null;

export type EarnLineResult = {
  lineId: string;
  quantity: number;
  netCents: number; // 折后、按含税口径原样（单价×数量 − 折扣），退款按比例时当分母
  eligibleCents: number; // 计分金额（已按规则去掉/加上税）
  excluded: ExclusionReason;
};

export type EarnResult = {
  points: number;
  eligibleCents: number; // = goodsCents + shippingCents + taxCents
  goodsCents: number;
  shippingCents: number; // 计分的运费部分（含运费税如 earnOnTax）
  taxCents: number; // 计分的商品税部分
  lines: EarnLineResult[];
};

const norm = (s: string) => s.trim().toLowerCase();

/** "12.34" / 12.34 / "-5" → 分。字符串按十进制解析，不经过浮点。 */
export function moneyToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const str = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(str);
  if (!m) return 0;
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2] || "0");
  const frac = (m[3] || "").padEnd(3, "0");
  // 第三位小数四舍五入（Shopify 金额本来就是两位）
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return sign * cents;
}

function toScaled(n: number): bigint {
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(Math.round(n * Number(SCALE)));
}

/** 金额（分）× 每 $1 几分 × 倍数 → 积分，向下取整。 */
export function pointsForCents(cents: number, pointsPerDollar: number, multiplier = 1): number {
  if (cents <= 0) return 0;
  const num = BigInt(Math.trunc(cents)) * toScaled(pointsPerDollar) * toScaled(multiplier);
  const den = 100n * SCALE * SCALE;
  return Number(num / den); // BigInt 除法本身就是向零取整；num ≥ 0 所以等于 floor
}

export function exclusionFor(line: EarnLine, rules: EarnRules): ExclusionReason {
  // 礼品卡永远不计分（买礼品卡不赚分，用礼品卡付款的订单照常按商品计分）
  if (line.giftCard) return "gift_card";
  const types = new Set(rules.excludedProductTypes.map(norm).filter(Boolean));
  if (line.productType && types.has(norm(line.productType))) return "product_type";
  const tags = new Set(rules.excludedTags.map(norm).filter(Boolean));
  if ((line.tags ?? []).some((t) => tags.has(norm(t)))) return "tag";
  if (rules.excludeDiscountedItems && line.discountCents > 0) return "discounted";
  return null;
}

export function computeEarnPoints(order: EarnOrderInput, rules: EarnRules): EarnResult {
  let goodsCents = 0;
  let taxCents = 0;
  const lines: EarnLineResult[] = order.lines.map((line) => {
    const qty = Math.max(0, line.quantity);
    const netCents = Math.max(0, line.unitPriceCents * qty - line.discountCents);
    const excluded = exclusionFor(line, rules);
    if (excluded) {
      return { lineId: line.lineId, quantity: qty, netCents, eligibleCents: 0, excluded };
    }
    const tax = Math.max(0, line.taxCents);
    const preTax = Math.max(0, order.taxesIncluded ? netCents - tax : netCents);
    const lineTax = rules.earnOnTax ? tax : 0;
    goodsCents += preTax;
    taxCents += lineTax;
    return {
      lineId: line.lineId,
      quantity: qty,
      netCents,
      eligibleCents: preTax + lineTax,
      excluded: null,
    };
  });

  let shippingCents = 0;
  if (rules.earnOnShipping) {
    const shipNet = Math.max(0, order.shippingCents - order.shippingDiscountCents);
    const shipTax = Math.max(0, order.shippingTaxCents);
    const shipPreTax = Math.max(0, order.taxesIncluded ? shipNet - shipTax : shipNet);
    shippingCents = shipPreTax + (rules.earnOnTax ? shipTax : 0);
  }

  const eligibleCents = goodsCents + taxCents + shippingCents;
  return {
    points: pointsForCents(eligibleCents, rules.pointsPerDollar, rules.tierMultiplier),
    eligibleCents,
    goodsCents,
    shippingCents,
    taxCents,
    lines,
  };
}

// ── 退款扣回 ────────────────────────────────────────────────────────────────

export type RefundLineInput = {
  lineId: string; // 原订单行 GID
  quantity: number;
  subtotalCents: number; // 该退款行的小计（折后），Shopify refund_line_items[].subtotal
};

export type RefundReversalInput = {
  earnedPoints: number; // 该订单 earn 流水的 delta
  earn: Pick<EarnResult, "eligibleCents" | "shippingCents" | "lines">; // earn 流水 meta 里存的计算明细
  refund: { lines: RefundLineInput[]; shippingRefundCents: number };
  alreadyRefundedEligibleCents: number; // 之前几次退款累计的「可计分金额」
  alreadyReversedPoints: number; // 之前几次退款已扣回的积分（正数）
};

export type RefundReversalResult = {
  refundedEligibleCents: number; // 本次退款对应的可计分金额
  cumulativeRefundedEligibleCents: number;
  pointsToReverse: number; // 本次要扣的分（正数；写 ledger 时取负）
};

/** 本次退款里有多少是「当初计了分」的金额。 */
export function refundedEligibleCents(
  earn: RefundReversalInput["earn"],
  refund: RefundReversalInput["refund"],
): number {
  const byId = new Map(earn.lines.map((l) => [l.lineId, l]));
  let total = 0;
  for (const r of refund.lines) {
    const line = byId.get(r.lineId);
    if (!line || line.eligibleCents <= 0) continue;
    let part: number;
    if (line.netCents > 0) {
      // 按退款小计 / 原行折后金额 的比例
      part = Math.round((line.eligibleCents * Math.max(0, r.subtotalCents)) / line.netCents);
    } else {
      part = line.quantity > 0 ? Math.round((line.eligibleCents * r.quantity) / line.quantity) : 0;
    }
    total += Math.min(line.eligibleCents, Math.max(0, part));
  }
  total += Math.min(earn.shippingCents, Math.max(0, refund.shippingRefundCents));
  return total;
}

/**
 * 按累计退款比例扣回：目标累计扣回 = floor(赚的分 × 累计退款可计分金额 / 当初可计分金额)，
 * 本次扣 = 目标 − 已扣。用累计算法，两次各退一半也能正好扣满，不会因为每次向下取整漏掉 1 分。
 */
export function computeRefundReversal(input: RefundReversalInput): RefundReversalResult {
  const thisRefund = refundedEligibleCents(input.earn, input.refund);
  const eligible = input.earn.eligibleCents;
  const cumulative = Math.min(eligible, Math.max(0, input.alreadyRefundedEligibleCents) + thisRefund);
  if (eligible <= 0 || input.earnedPoints <= 0) {
    return { refundedEligibleCents: thisRefund, cumulativeRefundedEligibleCents: cumulative, pointsToReverse: 0 };
  }
  const target = Number((BigInt(input.earnedPoints) * BigInt(cumulative)) / BigInt(eligible));
  const pointsToReverse = Math.max(0, Math.min(input.earnedPoints, target) - Math.max(0, input.alreadyReversedPoints));
  return { refundedEligibleCents: thisRefund, cumulativeRefundedEligibleCents: cumulative, pointsToReverse };
}

// ── 兑分 ────────────────────────────────────────────────────────────────────

export type RedeemRules = {
  redeemPointsPerDollar: number;
  minRedeemPoints: number;
  redeemStepPoints: number;
};

/** 积分 → 抵扣金额（分），向下取整到分。 */
export function redeemValueCents(points: number, rules: RedeemRules): number {
  if (points <= 0 || rules.redeemPointsPerDollar <= 0) return 0;
  return Math.floor((points * 100) / rules.redeemPointsPerDollar);
}

export function validateRedeemPoints(
  points: number,
  balance: number,
  rules: RedeemRules,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(points) || points <= 0) return { ok: false, error: "Points must be a positive whole number" };
  if (points < rules.minRedeemPoints) return { ok: false, error: `Minimum redemption is ${rules.minRedeemPoints} points` };
  if (rules.redeemStepPoints > 0 && points % rules.redeemStepPoints !== 0)
    return { ok: false, error: `Redeem in steps of ${rules.redeemStepPoints} points` };
  if (points > balance) return { ok: false, error: "Not enough points" };
  return { ok: true };
}
