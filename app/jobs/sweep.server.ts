// loyalty.sweep（每 10 分钟）：补漏。
// 1. 落了库但没入队成功的事件（status = received 超过 2 分钟）→ 重新入队
// 2. 待确认积分到期（pendingCached > 0）→ 重算缓存 + 同步 metafield
import prisma from "../db.server";
import { JOB_FOR_TOPIC } from "../models/webhookEvents.server";
import { recomputeCaches, withMemberLock } from "../models/loyalty.server";
import { enqueue, QUEUES } from "./queue.server";

export async function handleSweep(): Promise<void> {
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
  if (requeued || matured) console.log(`[loyalty.sweep] requeued ${requeued} events, ${matured} members had points mature`);
}
