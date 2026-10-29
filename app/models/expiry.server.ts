// 积分过期（LoyaltyConfig.expiryMode = inactivity）：N 个月没有任何赚分 / 兑换 / 调分 → 余额清零，写一条 expire 流水。
// 幂等：referenceId = expire:<memberId>:<最后一次活动时间戳>，同一段"静止期"只清一次；之后客人再活动又从头计。
// 只清正余额；负余额（退款扣回后欠分）不动。
import prisma from "../db.server";
import { insertLedger, withMemberLock } from "./ledger.server";
import { getLoyaltySettings } from "./loyalty.server";

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const ACTIVITY_TYPES = ["earn", "redeem", "adjust", "migrate", "signup_bonus", "refund_reverse", "redeem_release"];

export type ExpiryResult = { shop: string; checked: number; expired: number; points: number };

/** 一个店跑一遍。limit 限制每次最多清多少人（sweep 每 10 分钟一次，慢慢清即可）。 */
export async function expireInactiveMembers(shop: string, now = new Date(), limit = 200): Promise<ExpiryResult | null> {
  const settings = await getLoyaltySettings(shop);
  if (settings.expiryMode !== "inactivity" || !settings.expiryMonths) return null;
  const cutoff = new Date(now.getTime() - settings.expiryMonths * MONTH_MS);

  // 候选：有正余额、且最近一条活动流水早于 cutoff
  const candidates = await prisma.member.findMany({
    where: { shopDomain: shop, balanceCached: { gt: 0 } },
    select: { id: true },
    take: 5000,
  });
  const out: ExpiryResult = { shop, checked: 0, expired: 0, points: 0 };
  for (const c of candidates) {
    if (out.expired >= limit) break;
    out.checked++;
    const last = await prisma.pointsLedger.findFirst({
      where: { memberId: c.id, type: { in: ACTIVITY_TYPES } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!last || last.createdAt > cutoff) continue;
    const done = await withMemberLock(c.id, async (tx) => {
      const fresh = await tx.member.findUniqueOrThrow({ where: { id: c.id } });
      if (fresh.balanceCached <= 0) return 0;
      const res = await insertLedger(tx, {
        memberId: c.id,
        delta: -fresh.balanceCached,
        type: "expire",
        referenceType: "inactivity",
        referenceId: `expire:${c.id}:${last.createdAt.getTime()}`,
        note: `Expired after ${settings.expiryMonths} months without activity (last activity ${last.createdAt.toISOString().slice(0, 10)})`,
        createdBy: "system",
      });
      return res.applied ? fresh.balanceCached : 0;
    });
    if (done > 0) {
      out.expired++;
      out.points += done;
    }
  }
  return out;
}

/** 所有配置了 inactivity 的店。 */
export async function expireInactiveAllShops(now = new Date()): Promise<ExpiryResult[]> {
  const shops = await prisma.loyaltyConfig.findMany({ where: { expiryMode: "inactivity" }, select: { shopDomain: true } });
  const results: ExpiryResult[] = [];
  for (const s of shops) {
    const r = await expireInactiveMembers(s.shopDomain, now);
    if (r) results.push(r);
  }
  return results;
}
