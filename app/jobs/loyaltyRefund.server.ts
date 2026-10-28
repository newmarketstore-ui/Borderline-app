// loyalty.refund_reverse：refunds/create → 按退款小计占原可计分金额的比例扣回（幂等键 = 退款 GID），允许余额变负。
import type { Prisma, WebhookEvent } from "@prisma/client";

import prisma from "../db.server";
import { computeRefundReversal, type EarnLineResult } from "../lib/loyaltyMath";
import { normalizeRefundWebhook } from "../lib/shopifyPayload";
import { insertLedger, isUniqueViolation, withMemberLock } from "../models/loyalty.server";
import { enqueue, QUEUES } from "./queue.server";

type EarnMeta = { eligibleCents?: number; shippingCents?: number; lines?: EarnLineResult[] };
type RefundMeta = { refundedEligibleCents?: number };

export async function handleRefundReverse(event: WebhookEvent): Promise<string | void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const refund = normalizeRefundWebhook(event.payload as Record<string, any>);

  const earn = await prisma.pointsLedger.findUnique({
    where: { type_referenceId: { type: "earn", referenceId: refund.orderGid } },
  });
  if (!earn) return "skipped: order has no earn entry";
  const earnMeta = (earn.meta ?? {}) as EarnMeta;

  let result: { applied: boolean; points: number; memberId: string };
  try {
    result = await withMemberLock(earn.memberId, async (tx) => {
      // 锁内读之前的扣回，保证同一订单多次退款的累计算法不被并发打乱
      const prior = await tx.pointsLedger.findMany({
        where: { type: "refund_reverse", orderId: refund.orderGid },
        select: { delta: true, meta: true, referenceId: true },
      });
      if (prior.some((p) => p.referenceId === refund.refundGid)) {
        return { applied: false, points: 0, memberId: earn.memberId };
      }
      const calc = computeRefundReversal({
        earnedPoints: earn.delta,
        earn: {
          eligibleCents: earnMeta.eligibleCents ?? 0,
          shippingCents: earnMeta.shippingCents ?? 0,
          lines: earnMeta.lines ?? [],
        },
        refund: { lines: refund.lines, shippingRefundCents: refund.shippingRefundCents },
        alreadyRefundedEligibleCents: prior.reduce(
          (s, p) => s + (((p.meta ?? {}) as RefundMeta).refundedEligibleCents ?? 0),
          0,
        ),
        alreadyReversedPoints: prior.reduce((s, p) => s - p.delta, 0),
      });
      // 本次退款不涉及计过分的金额（比如只退礼品卡）→ 不写
      if (calc.refundedEligibleCents <= 0) return { applied: false, points: 0, memberId: earn.memberId };
      // 扣 0 分也写一行（delta = 0）：累计算法要记住这次退了多少可计分金额
      const r = await insertLedger(tx, {
        memberId: earn.memberId,
        delta: -calc.pointsToReverse,
        type: "refund_reverse",
        referenceType: "refund",
        referenceId: refund.refundGid,
        orderId: refund.orderGid,
        orderName: earn.orderName,
        createdBy: "system",
        meta: {
          refundedEligibleCents: calc.refundedEligibleCents,
          cumulativeRefundedEligibleCents: calc.cumulativeRefundedEligibleCents,
          refundLines: refund.lines,
          shippingRefundCents: refund.shippingRefundCents,
        } as Prisma.InputJsonValue,
      });
      return { applied: r.applied, points: calc.pointsToReverse, memberId: earn.memberId };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "already applied (idempotent)";
    throw e;
  }

  if (!result.applied) return "skipped: nothing to reverse or already applied";
  if (result.points > 0) {
    await enqueue(QUEUES.syncBalance, { shop: event.shopDomain, memberId: result.memberId }, {}, 10_000);
  }
}
