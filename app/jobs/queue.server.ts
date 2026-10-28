// pg-boss 任务队列：跑在同一个 Supabase Postgres（DATABASE_URL）里，schema = pgboss，不另加 Redis。
// 这个文件只负责「连上 + 发任务」；worker 注册在 ./worker.server.ts。
// 安全：绝不打印连接串；错误日志只打 message。
import PgBoss from "pg-boss";

export const QUEUES = {
  earn: "loyalty.earn",
  refundReverse: "loyalty.refund_reverse",
  syncCustomer: "loyalty.sync_customer",
  syncBalance: "loyalty.sync_balance",
  syncMembership: "loyalty.sync_membership",
  gdpr: "gdpr.process",
  sweep: "loyalty.sweep",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

// webhook 事件类任务只带 WebhookEvent.id，payload 从库里读
export type EventJobData = { eventId: string };
export type SyncBalanceJobData = { shop: string; memberId: string };
export type SyncMembershipJobData = { shop: string; customerGid: string };

declare global {
  // eslint-disable-next-line no-var
  var __blBossPromise: Promise<PgBoss> | undefined;
}

function createBoss(): PgBoss {
  const connectionString = process.env.PGBOSS_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set; job queue disabled");
  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    // Supabase session pooler 连接数有限；Prisma 自己还有一个池
    max: Number(process.env.PGBOSS_POOL_MAX) || 3,
    application_name: "borderline-ai-pgboss",
    // PGBOSS_SSL=require → 走 TLS 但不校验证书链（Supabase pooler 证书链 node 默认不认）
    ...(process.env.PGBOSS_SSL === "require" ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  boss.on("error", (err: Error) => console.error("[pg-boss] error:", err.message));
  return boss;
}

async function startBoss(): Promise<PgBoss> {
  const boss = createBoss();
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    // createQueue 在 v10 里是幂等的（ON CONFLICT DO NOTHING）
    await boss.createQueue(name, {
      name,
      retryLimit: name === QUEUES.sweep ? 0 : 6,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  }
  return boss;
}

/** 进程内单例（dev 下 HMR 重新执行模块也不会重复连）。启动失败会清掉缓存，下次调用再试。 */
export function getBoss(): Promise<PgBoss> {
  if (!globalThis.__blBossPromise) {
    globalThis.__blBossPromise = startBoss().catch((err: unknown) => {
      globalThis.__blBossPromise = undefined;
      throw err;
    });
  }
  return globalThis.__blBossPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 发任务。webhook 路由里用：有超时，保证 Shopify 5 秒内拿到 200。 */
export async function enqueue(
  name: QueueName,
  data: EventJobData | SyncBalanceJobData | SyncMembershipJobData | Record<string, never>,
  options: PgBoss.SendOptions = {},
  timeoutMs = 3000,
): Promise<string | null> {
  const boss = await withTimeout(getBoss(), timeoutMs, "pg-boss start");
  return withTimeout(boss.send(name, data, options), timeoutMs, `enqueue ${name}`);
}
