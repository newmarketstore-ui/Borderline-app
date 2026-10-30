// 启动 pg-boss worker：在 entry.server.tsx 里调用 startJobsOnce()。
// - 进程内只启动一次（globalThis 标记，dev 下 HMR 重新执行 entry 也不会重复注册）
// - JOBS_DISABLED=1 时不跑 worker（只发任务），比如本地调试或以后多机部署只让一台跑
// - 启动失败只记日志不让网站挂掉；webhook 照常落库，恢复后 sweep 会补
import type PgBoss from "pg-boss";

import { processEvent } from "../models/webhookEvents.server";
import { getBoss, QUEUES, type EventJobData, type SyncBalanceJobData, type SyncMembershipJobData, type SyncTagJobData } from "./queue.server";
import { handleEarn } from "./loyaltyEarn.server";
import { handleRefundReverse } from "./loyaltyRefund.server";
import { handleSyncBalance, handleSyncCustomer, handleSyncMembership, handleSyncTag } from "./loyaltySyncCustomer.server";
import { handleGdpr } from "./gdpr.server";
import { handleSweep } from "./sweep.server";

declare global {
  // eslint-disable-next-line no-var
  var __blJobsStarted: boolean | undefined;
}

const POLL = { batchSize: 1, pollingIntervalSeconds: 5 };

async function registerWorkers(boss: PgBoss) {
  const eventQueue = (name: string, handler: Parameters<typeof processEvent>[1]) =>
    boss.work<EventJobData>(name, POLL, async ([job]) => {
      await processEvent(job.data.eventId, handler);
    });

  await eventQueue(QUEUES.earn, (event) => handleEarn(event));
  await eventQueue(QUEUES.refundReverse, handleRefundReverse);
  await eventQueue(QUEUES.syncCustomer, handleSyncCustomer);
  await eventQueue(QUEUES.gdpr, handleGdpr);
  await boss.work<SyncBalanceJobData>(QUEUES.syncBalance, POLL, async ([job]) => {
    await handleSyncBalance(job.data);
  });
  await boss.work<SyncMembershipJobData>(QUEUES.syncMembership, POLL, async ([job]) => {
    await handleSyncMembership(job.data);
  });
  await boss.work<SyncTagJobData>(QUEUES.syncTag, POLL, async ([job]) => {
    await handleSyncTag(job.data);
  });
  await boss.work(QUEUES.sweep, { batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
    await handleSweep();
  });
  await boss.schedule(QUEUES.sweep, "*/10 * * * *", {}, { tz: "America/Toronto" });
}

export function startJobsOnce(): void {
  if (globalThis.__blJobsStarted) return;
  globalThis.__blJobsStarted = true;
  if (process.env.JOBS_DISABLED === "1") {
    console.log("[jobs] JOBS_DISABLED=1, workers not started");
    return;
  }
  getBoss()
    .catch((err: unknown) => {
      // 连不上库：清掉标记，下一次 startJobsOnce()（下一个页面请求）再试
      globalThis.__blJobsStarted = false;
      throw err;
    })
    .then(registerWorkers)
    .then(() => console.log("[jobs] pg-boss workers started"))
    .catch((err: unknown) => console.error("[jobs] failed to start pg-boss workers:", (err as Error).message));
}
