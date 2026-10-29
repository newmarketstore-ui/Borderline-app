// 积分流水底层：只追加写 + 会员行锁 + 余额缓存。只依赖 Prisma（不碰 shopify.server），
// 所以导入脚本 scripts/loyalty/importAppstle.ts 和冒烟脚本能直接用。
import { Prisma, type Member, type PointsLedger } from "@prisma/client";

import prisma from "../db.server";

// ── 流水（只追加）+ 余额缓存 ─────────────────────────────────────────────────

export type Tx = Prisma.TransactionClient;

export type LedgerEntryInput = {
  memberId: string;
  delta: number;
  type: "earn" | "redeem" | "redeem_release" | "refund_reverse" | "adjust" | "expire" | "migrate" | "signup_bonus";
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
