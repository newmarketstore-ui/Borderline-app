// loyalty.sweep（每 10 分钟）：补漏。
// 1. 落了库但没入队成功的事件（status = received 超过 2 分钟）→ 重新入队
// 2. 待确认积分到期（pendingCached > 0）→ 重算缓存 + 同步 metafield
// 3. 兑换码过期未用 → 停用 Shopify 折扣 + redeem_release 退分；扣了分却没拿到码 / Store Credit 交易号的孤儿 → 退分
// 4. 积分过期（expiryMode = inactivity 的店）：N 个月没活动 → 余额清零
// 5. 服务工单：ready 超过 SERVICE_REMINDER_DAYS（默认 3）天没取 → 发取件提醒
import prisma from "../db.server";
import { JOB_FOR_TOPIC } from "../models/webhookEvents.server";
import { getAdminForShop, recomputeCaches, withMemberLock, type AdminGraphql } from "../models/loyalty.server";
import { expireInactiveAllShops } from "../models/expiry.server";
import { sweepRedemptions } from "../models/redemption.server";
import { sendPickupReminders } from "../models/services.server";
import { enqueue, QUEUES } from "./queue.server";

export async function handleSweep(
  deps: { getAdmin: (shop: string) => Promise<AdminGraphql> } = { getAdmin: getAdminForShop },
): Promise<void> {
  const stale = await prisma.webhookEvent.findMany({
    where: { status: "received", receivedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) } },
    orderBy: { receivedAt: "asc" },
    take: 500,
    select: { id: true, topic: true },
  });
  let requeued = 0;
  for (const ev of stale) {
    const job = JOB_FOR_TOPIC[ev.topic];
    if (!job) continue;
    await enqueue(job, { eventId: ev.id }, {}, 10_000);
    await prisma.webhookEvent.updateMany({ where: { id: ev.id, status: "received" }, data: { status: "queued" } });
    requeued++;
  }

  const pending = await prisma.member.findMany({
    where: { pendingCached: { gt: 0 } },
    select: { id: true, shopDomain: true, balanceCached: true },
    take: 1000,
  });
  let matured = 0;
  for (const m of pending) {
    const updated = await withMemberLock(m.id, (tx) => recomputeCaches(tx, m.id));
    if (updated.balanceCached !== m.balanceCached) {
      await enqueue(QUEUES.syncBalance, { shop: m.shopDomain, memberId: m.id }, {}, 10_000);
      matured++;
    }
  }
  const { released, ...red } = await sweepRedemptions({ getAdmin: deps.getAdmin });
  for (const r of released) await enqueue(QUEUES.syncBalance, r, {}, 10_000);

  const expiry = await expireInactiveAllShops();
  for (const e of expiry) if (e.expired) console.log(`[loyalty.sweep] ${e.shop}: expired ${e.expired} members, ${e.points} points`);

  try {
    const rem = await sendPickupReminders();
    if (rem.sent || rem.errors) console.log(`[loyalty.sweep] service pickup reminders: ${JSON.stringify(rem)}`);
  } catch (e) {
    console.error(`[loyalty.sweep] pickup reminders failed: ${(e as Error).message}`);
  }

  if (requeued || matured || red.expired || red.orphans || red.usedLate || red.errors)
    console.log(
      `[loyalty.sweep] requeued ${requeued} events, ${matured} members had points mature, redemptions: ${JSON.stringify(red)}`,
    );
}
