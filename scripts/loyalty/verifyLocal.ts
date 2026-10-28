// 积分模块本地全流程验证（一次性本地 Postgres，跑完删数据）：
//
//   npx tsx scripts/loyalty/verifyLocal.ts [--export-dir <backups/loyalty-migration/<ts>>]
//
// 1. 起本地库（scripts/loyalty/localDb.ts）→ prisma migrate deploy（从空库跑全部迁移）→ migrate diff 确认迁移 = schema
// 2. importAppstle.ts：dry-run → --apply --only <一个有 gold-membership 的非异常客户> → --apply 全部 → 再 --apply 一次（计数不变 = 幂等）
// 3. smokeQueue.ts：pg-boss + 任务端到端（Admin API 用桩）
// 4. 停库、删数据目录（PostgreSQL 二进制留在 node_modules）
//
// 安全：DATABASE_URL 只放进子进程环境，值永远是 127.0.0.1 上的一次性库；.env（生产库）不读、不用。
// 输出只有计数和客户数字 ID，不打印邮箱 / 电话 / 姓名。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  customerGid,
  membersFromBulkJsonl,
  parseMigrateRows,
  planImportRow,
  summarizePlans,
} from "../../app/lib/appstleImport";
import { hasMemberTag } from "../../app/lib/membership";
import { assertLocalUrl, startLocalDb, type LocalDb } from "./localDb";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_BACKUPS = resolve(REPO, "..", "backups", "loyalty-migration");
const PRISMA_CLI = join(REPO, "node_modules", "prisma", "build", "index.js");
const TSX_CLI = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const SHOP = "verify-local.myshopify.com";
const MEMBER_TAG = "gold-membership";

function newestExportDir(): string {
  const i = process.argv.indexOf("--export-dir");
  if (i > 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  if (!existsSync(KB_BACKUPS))
    throw new Error(`No export folder at ${KB_BACKUPS}; pass --export-dir`);
  const dirs = readdirSync(KB_BACKUPS)
    .map((d) => join(KB_BACKUPS, d))
    .filter(
      (d) =>
        statSync(d).isDirectory() && existsSync(join(d, "migrate_rows.jsonl")),
    )
    .sort();
  if (!dirs.length)
    throw new Error(`No <ts>/migrate_rows.jsonl under ${KB_BACKUPS}`);
  return dirs[dirs.length - 1];
}

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
function record(name: string, ok: boolean, detail = "") {
  steps.push({ name, ok, detail });
  console.log(
    `\n[verify] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`,
  );
  if (!ok) throw new Error(`step failed: ${name}`);
}

/** 跑子进程（node 直接执行 CLI 入口，避开 Windows 路径空格 / shell 引号）。DATABASE_URL 只在这里注入。 */
function run(
  label: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { echo?: boolean } = {},
) {
  console.log(`\n[verify] $ ${label}`);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (opts.echo !== false)
    process.stdout.write(
      out
        .split("\n")
        .filter(
          (l) => !/shamefully-hoist|Update available|pris\.ly\/tip/.test(l),
        )
        .join("\n"),
    );
  return { code: r.status ?? 1, out };
}

type Counts = {
  members: number;
  memberships: number;
  snapshots: number;
  ledger: number;
  points: number;
};
async function counts(db: LocalDb): Promise<Counts> {
  const [r] = await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM "Member" WHERE "shopDomain" = $1) AS members,
            (SELECT count(*) FROM "Membership" ms JOIN "Member" m ON m.id = ms."memberId" WHERE m."shopDomain" = $1) AS memberships,
            (SELECT count(*) FROM "MigrationSnapshot") AS snapshots,
            (SELECT count(*) FROM "PointsLedger" WHERE type = 'migrate') AS ledger,
            (SELECT coalesce(sum(delta), 0) FROM "PointsLedger" WHERE type = 'migrate') AS points`,
    [SHOP],
  );
  return {
    members: Number(r.members),
    memberships: Number(r.memberships),
    snapshots: Number(r.snapshots),
    ledger: Number(r.ledger),
    points: Number(r.points),
  };
}
const fmt = (c: Counts) =>
  `members ${c.members}, memberships ${c.memberships}, snapshots ${c.snapshots}, migrate ledger rows ${c.ledger}, points ${c.points}`;

async function main() {
  const exportDir = newestExportDir();
  const rowsFile = join(exportDir, "migrate_rows.jsonl");
  const membersFile = join(exportDir, "customers_bulk.jsonl");
  console.log(`[verify] export folder: ${exportDir}`);

  // 期望值：用同一套纯函数规划（不连库）
  const rows = parseMigrateRows(readFileSync(rowsFile, "utf8"));
  const members = membersFromBulkJsonl(readFileSync(membersFile, "utf8"));
  const now = new Date();
  const plans = rows.map((r) =>
    planImportRow(r, members.get(r.shopifyCustomerId), {
      includeAnomalies: false,
      pendingDays: 0,
      now,
    }),
  );
  const expected = summarizePlans(plans, MEMBER_TAG);
  const pick = plans
    .filter(
      (p) =>
        !p.skip &&
        p.ledger.length > 0 &&
        hasMemberTag(p.member.tags, MEMBER_TAG),
    )
    // 优先挑同时有 Appstle 会员合约的，顺带验证 Membership 写入
    .sort(
      (x, y) =>
        Number(y.memberships.length > 0) - Number(x.memberships.length > 0) ||
        x.numericId.localeCompare(y.numericId),
    )[0];
  if (!pick)
    throw new Error(
      "no non-anomaly gold-membership row with points to use for --only",
    );
  const expectedMemberships = new Set(
    plans
      .filter((p) => !p.skip)
      .flatMap((p) => p.memberships.map((m) => `${m.source}:${m.externalId}`)),
  ).size;
  console.log(
    `[verify] ${rows.length} migrate rows, ${expected.planned} to import, ${expected.skippedAnomaly} anomalies skipped, ${expected.ledgerRows} ledger rows, ${expected.availablePoints + expected.pendingPoints} points; --only customer ${pick.numericId}`,
  );

  const db = await startLocalDb({ quiet: true });
  const url = assertLocalUrl(db.url);
  const target = `127.0.0.1:${db.port}/loyalty_dev`;
  console.log(`[verify] local Postgres up: ${url}`);
  // 子进程环境：DATABASE_URL / PGBOSS_DATABASE_URL 都指本地库（Prisma 读 .env 时不会覆盖已设的变量）
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    PGBOSS_DATABASE_URL: url,
  };
  delete env.PGBOSS_SSL;
  const importer = [
    "scripts/loyalty/importAppstle.ts",
    "--rows",
    rowsFile,
    "--members",
    membersFile,
  ];
  const apply = [
    ...importer,
    "--apply",
    "--shop",
    SHOP,
    "--confirm-db",
    target,
  ];

  const summary: Record<string, string> = {};
  try {
    // 1. 迁移
    const mig = run(
      "prisma migrate deploy",
      [PRISMA_CLI, "migrate", "deploy"],
      env,
    );
    const migrations = readdirSync(join(REPO, "prisma", "migrations")).filter(
      (d) => /^\d{14}_/.test(d),
    );
    const applied = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    record(
      "migrate deploy from an empty database",
      mig.code === 0 &&
        mig.out.includes(`127.0.0.1:${db.port}`) &&
        Number(applied[0].n) === migrations.length,
      `${applied[0].n}/${migrations.length} migrations applied`,
    );
    const diff = run(
      "prisma migrate diff (database vs schema.prisma)",
      [
        PRISMA_CLI,
        "migrate",
        "diff",
        "--from-url",
        url,
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      env,
    );
    record(
      "migrations match schema.prisma (no drift)",
      diff.code === 0,
      diff.code === 0 ? "empty diff" : `exit ${diff.code}`,
    );
    summary.migrations = `${applied[0].n} applied, no drift`;

    // 2. 导入
    const dry = run("importAppstle dry-run", [TSX_CLI, ...importer], env);
    const afterDry = await counts(db);
    record(
      "importer dry-run writes nothing",
      dry.code === 0 && afterDry.members === 0 && afterDry.ledger === 0,
      fmt(afterDry),
    );

    const one = run(
      `importAppstle --apply --only ${pick.numericId}`,
      [TSX_CLI, ...apply, "--only", pick.numericId],
      env,
    );
    const afterOne = await counts(db);
    const [oneRow] = await db.query<{
      tier: string;
      synced: boolean;
      balance: number;
    }>(
      `SELECT tier, "membershipSyncedAt" IS NOT NULL AS synced, "balanceCached" AS balance FROM "Member" WHERE "shopifyCustomerId" = $1`,
      [customerGid(pick.numericId)],
    );
    const pickPoints = pick.ledger.reduce((s, l) => s + l.delta, 0);
    record(
      "importer --apply --only one gold-membership customer",
      one.code === 0 &&
        afterOne.members === 1 &&
        afterOne.snapshots === 1 &&
        afterOne.memberships === pick.memberships.length &&
        afterOne.ledger === pick.ledger.length &&
        afterOne.points === pickPoints &&
        oneRow?.tier === "paid" &&
        oneRow.synced,
      `${fmt(afterOne)}; tier ${oneRow?.tier}, membership synced ${oneRow?.synced}`,
    );

    const all = run(
      "importAppstle --apply (all rows)",
      [TSX_CLI, ...apply],
      env,
    );
    const afterAll = await counts(db);
    const [bal] = await db.query<{
      cached: string;
      ledger: string;
      negative: string;
    }>(
      `SELECT (SELECT coalesce(sum("balanceCached" + "pendingCached"), 0) FROM "Member" WHERE "shopDomain" = $1) AS cached,
              (SELECT coalesce(sum(delta), 0) FROM "PointsLedger") AS ledger,
              (SELECT count(*) FROM "Member" WHERE "shopDomain" = $1 AND "balanceCached" < 0) AS negative`,
      [SHOP],
    );
    record(
      "importer --apply all rows",
      all.code === 0 &&
        afterAll.members === expected.planned &&
        afterAll.snapshots === expected.planned &&
        afterAll.ledger === expected.ledgerRows &&
        afterAll.points === expected.availablePoints + expected.pendingPoints &&
        afterAll.memberships === expectedMemberships &&
        Number(bal.cached) === Number(bal.ledger),
      `${fmt(afterAll)}; expected members ${expected.planned}, ledger ${expected.ledgerRows}, memberships ${expectedMemberships}; cached balances = ledger sum (${bal.cached}); negative balances ${bal.negative}`,
    );

    const again = run(
      "importAppstle --apply (second run)",
      [TSX_CLI, ...apply],
      env,
    );
    const afterAgain = await counts(db);
    record(
      "importer second --apply is idempotent",
      again.code === 0 &&
        JSON.stringify(afterAgain) === JSON.stringify(afterAll),
      fmt(afterAgain),
    );
    summary.import = `${fmt(afterAll)} (negative balances ${bal.negative}); second run unchanged`;

    // 3. 队列冒烟
    const smoke = run(
      "smokeQueue.ts",
      [TSX_CLI, "scripts/loyalty/smokeQueue.ts"],
      env,
    );
    const smokeLine = smoke.out.match(
      /\[smoke\] (\d+) checks passed, (\d+) failed/,
    );
    record(
      "pg-boss smoke test",
      smoke.code === 0 && Boolean(smokeLine) && smokeLine![2] === "0",
      smokeLine ? smokeLine[0].replace("[smoke] ", "") : `exit ${smoke.code}`,
    );
    summary.smoke = smokeLine ? `${smokeLine[1]} checks passed` : "";
  } finally {
    await db.stop();
    console.log(
      `\n[verify] local Postgres stopped, data deleted (${existsSync(db.dataDir) ? "STILL PRESENT" : "gone"})`,
    );
  }

  console.log("\n[verify] summary");
  console.table(
    Object.fromEntries(steps.map((s) => [s.name, s.ok ? "PASS" : "FAIL"])),
  );
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  console.log(
    steps.every((s) => s.ok) ? "[verify] ALL PASSED" : "[verify] FAILED",
  );
}

main().catch((e: unknown) => {
  console.error("\n[verify] error:", (e as Error).message);
  process.exit(1);
});
