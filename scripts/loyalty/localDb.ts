// 一次性本地 Postgres（npm 包 embedded-postgres，二进制在 node_modules 里，不需要 Docker / 系统 Postgres / WSL）。
//
//   npx tsx scripts/loyalty/localDb.ts          # 启动，打印连接串，Ctrl+C 停止并删除数据目录
//
// 也可以 import { startLocalDb }（verifyLocal.ts 用）。数据目录在 <repo>/.local-pg/<端口>/（.gitignore 已排除），
// 停止时连同数据一起删掉；PostgreSQL 二进制留在 node_modules，下次直接用。
// 账号密码固定 postgres / postgres，只监听 127.0.0.1，连接串里没有任何真实凭证，可以打印。
import { rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LOCAL_PG_ROOT = join(REPO_ROOT, ".local-pg");
export const LOCAL_DB_NAME = "loyalty_dev";

export type LocalDb = {
  url: string;
  port: number;
  dataDir: string;
  /** 直接查本地库（计数用），每次新开一个连接。 */
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
  stop: () => Promise<void>;
};

/** 让操作系统给一个空闲端口。 */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() =>
        port ? res(port) : rej(new Error("could not get a free port")),
      );
    });
  });
}

export async function startLocalDb(
  opts: { port?: number; quiet?: boolean } = {},
): Promise<LocalDb> {
  const port = opts.port ?? (await freePort());
  const dataDir = join(LOCAL_PG_ROOT, String(port));
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(LOCAL_PG_ROOT, { recursive: true });
  const logs: string[] = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password: "postgres",
    authMethod: "password",
    persistent: true, // 由我们自己删目录（库自带的删除在 Windows 上偶尔被占用文件挡住）
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "fsync=off"],
    onLog: (m) => {
      logs.push(String(m));
      if (logs.length > 200) logs.shift();
    },
    onError: (m) => {
      logs.push(`ERR ${m instanceof Error ? m.message : String(m)}`);
      if (!opts.quiet)
        console.error("[local-pg]", m instanceof Error ? m.message : String(m));
    },
  });
  let started = false;
  const stop = async () => {
    try {
      if (started) await pg.stop();
    } finally {
      started = false;
      // Windows 上 postgres 子进程退出后文件句柄释放会晚一点，重试几次
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  };
  try {
    await pg.initialise();
    await pg.start();
    started = true;
    await pg.createDatabase(LOCAL_DB_NAME);
  } catch (e) {
    await stop().catch(() => undefined);
    const tail = logs.slice(-15).join("\n");
    throw new Error(
      `local Postgres failed to start: ${(e as Error).message}\n${tail}`,
    );
  }
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/${LOCAL_DB_NAME}`;
  const query = async <T>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const client = pg.getPgClient(LOCAL_DB_NAME, "127.0.0.1");
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  return { url, port, dataDir, query, stop };
}

/** 只允许本机库：verifyLocal / smokeQueue / 导入脚本的本地验证都先过这一关。 */
export function assertLocalUrl(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_URL is not set");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `Refusing to use database host ${host}; only a local database is allowed here`,
    );
  }
  return url;
}

// 直接运行：启动并挂着，Ctrl+C 停止 + 删数据
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const db = await startLocalDb();
  console.log(`[local-pg] running on port ${db.port}, data in ${db.dataDir}`);
  console.log(`[local-pg] DATABASE_URL=${db.url}`);
  console.log("[local-pg] Ctrl+C to stop and delete the data directory");
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await db.stop();
    console.log("[local-pg] stopped, data deleted");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => undefined, 1 << 30);
}
