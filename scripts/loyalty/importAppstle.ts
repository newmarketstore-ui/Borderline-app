// Appstle Loyalty → BorderlineAI 积分迁移导入。
//
//   npx tsx scripts/loyalty/importAppstle.ts --rows <migrate_rows.jsonl> [--members <customers_bulk.jsonl | customers_loyalty.csv>]
//        [--only <customerId>] [--include-anomalies] [--all-members] [--pending-days N]
//        [--apply --shop <shop>.myshopify.com --confirm-db <host:port/db>]
//
// 默认 dry-run：只读文件、打印汇总，不连数据库。
// --apply：写 Member / Membership / MigrationSnapshot / PointsLedger(type = migrate)。幂等，可重复跑：
//   流水幂等键 appstle:<数字 ID>（可用积分）、appstle:<数字 ID>:pending（待定积分）；快照按 (appstle_loyalty, 客户 GID) 唯一。
// 安全：
//   - 只认显式设置的 DATABASE_URL 环境变量（不读 .env，那是生产库），且 --confirm-db 必须等于它的 host:port/db
//   - 永不打印邮箱 / 电话 / 姓名；输出只有计数、积分合计、客户数字 ID
//   - flags 含 anomaly_huge_balance 的行默认清零迁入（老板 2026-10-29：内部测试弄的）；--include-anomalies 才原样迁
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";

import {
  customerGid,
  membersFromBulkJsonl,
  membersFromCsv,
  parseMigrateRows,
  planImportRow,
  summarizePlans,
  type ExportMember,
  type ImportPlan,
} from "../../app/lib/appstleImport";
import { isMember, paidUntilFrom } from "../../app/lib/membership";

type Args = {
  rows: string;
  members: string | null;
  apply: boolean;
  only: string | null;
  includeAnomalies: boolean;
  multiplier: number | null; // 旧分倍数；null = 按库里 / 默认规则 migrationPointsMultiplier（10）
  allMembers: boolean;
  pendingDays: number | null;
  shop: string | null;
  confirmDb: string | null;
  memberTag: string;
};

// 与 app/models/loyalty.server.ts DEFAULT_SETTINGS.migrationPointsMultiplier 一致（脚本不引 shopify.server，所以单独写死）
const FALLBACK_MULTIPLIER = 10;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    rows: "",
    members: null,
    apply: false,
    only: null,
    includeAnomalies: false,
    multiplier: null,
    allMembers: false,
    pendingDays: null,
    shop: null,
    confirmDb: null,
    memberTag: "gold-membership",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${k} needs a value`);
      return val;
    };
    if (k === "--rows") a.rows = v();
    else if (k === "--members") a.members = v();
    else if (k === "--apply") a.apply = true;
    else if (k === "--only") a.only = v();
    else if (k === "--include-anomalies") a.includeAnomalies = true;
    else if (k === "--multiplier") a.multiplier = Number(v());
    else if (k === "--all-members") a.allMembers = true;
    else if (k === "--pending-days") a.pendingDays = Number(v());
    else if (k === "--shop") a.shop = v();
    else if (k === "--confirm-db") a.confirmDb = v();
    else if (k === "--member-tag") a.memberTag = v();
    else if (k === "--help" || k === "-h") {
      console.log(
        readFileSync(new URL(import.meta.url), "utf8")
          .split("\n")
          .slice(0, 16)
          .join("\n"),
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${k}`);
  }
  if (!a.rows) throw new Error("--rows <migrate_rows.jsonl> is required");
  return a;
}

/** postgresql://user:pass@host:port/db?x → host:port/db（不含账号密码）。 */
function dbTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

function loadMembers(path: string): Map<string, ExportMember> {
  const text = readFileSync(path, "utf8");
  return path.toLowerCase().endsWith(".csv")
    ? membersFromCsv(text)
    : membersFromBulkJsonl(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  let rows = parseMigrateRows(readFileSync(args.rows, "utf8"));
  const members = args.members
    ? loadMembers(args.members)
    : new Map<string, ExportMember>();
  if (args.only) {
    const want = customerGid(args.only);
    rows = rows.filter((r) => r.shopifyCustomerId === want);
    if (!rows.length)
      console.warn(
        `[import] --only ${args.only}: no migrate row for this customer`,
      );
  }

  // apply 前先校验目标库，再按库里的 pendingDays 规划
  let db: Awaited<ReturnType<typeof openDb>> | null = null;
  if (args.apply) {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "--apply needs DATABASE_URL set explicitly in the environment (.env is not read)",
      );
    const target = dbTarget(url);
    if (!args.shop)
      throw new Error("--apply needs --shop <shop>.myshopify.com");
    if (args.confirmDb !== target)
      throw new Error(
        `--apply needs --confirm-db ${target} (the DATABASE_URL target)`,
      );
    console.log(`[import] APPLY to ${target}, shop ${args.shop}`);
    db = await openDb();
  } else {
    console.log(
      "[import] DRY RUN (no database connection; add --apply to write)",
    );
  }

  const config =
    db && args.shop
      ? await db.prisma.loyaltyConfig.findUnique({
          where: { shopDomain: args.shop },
        })
      : null;
  const pendingDays = args.pendingDays ?? config?.pendingDays ?? 0;
  const multiplier =
    args.multiplier ??
    (config?.migrationPointsMultiplier !== undefined && config?.migrationPointsMultiplier !== null
      ? Number(config.migrationPointsMultiplier.toString())
      : FALLBACK_MULTIPLIER);
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error(`bad --multiplier ${multiplier}`);
  console.log(`[import] points multiplier x${multiplier} (Appstle 10 pts = $1 -> ours 100 pts = $1)`);
  const memberTag = config?.memberTag ?? args.memberTag;

  const plans = rows.map((r) =>
    planImportRow(r, members.get(r.shopifyCustomerId), {
      includeAnomalies: args.includeAnomalies,
      multiplier,
      pendingDays,
      now,
    }),
  );
  // --all-members：没有积分的会员（有标签或有效合约）也建 Member + Membership，切换后第一单就不用临时去 Shopify 查
  const extra: ExportMember[] = [];
  if (args.allMembers && !args.only) {
    const withRows = new Set(rows.map((r) => r.shopifyCustomerId));
    for (const m of members.values())
      if (
        !withRows.has(m.shopifyCustomerId) &&
        isMember({ tags: m.tags, memberships: m.subscriptions }, now, memberTag)
      )
        extra.push(m);
  }

  const summary = summarizePlans(plans, memberTag);
  console.log("\nPlan (points are floored; emails are never printed)");
  console.table({
    "migrate rows read": summary.rows,
    "skipped: anomaly_huge_balance": summary.skippedAnomaly,
    "zeroed: anomaly_huge_balance (owner 10/29)": summary.zeroedAnomaly,
    "rows to import": summary.planned,
    "with member file record": summary.withMemberRecord,
    [`tagged ${memberTag}`]: summary.memberTagged,
    "membership rows (all / active)": `${summary.membershipRows} / ${summary.activeMemberships}`,
    "ledger rows (migrate)": summary.ledgerRows,
    "available points": summary.availablePoints,
    "pending points": summary.pendingPoints,
    "negative balances (rows / points)": `${summary.negativeRows} / ${summary.negativePoints}`,
    "members without points (--all-members)": extra.length,
    "pending points available at":
      pendingDays > 0 ? `now + ${pendingDays} days` : "now",
  });
  console.log("Flags:", JSON.stringify(summary.flags));
  if (args.only)
    for (const p of plans)
      console.log(
        `  customer ${p.numericId}: ${JSON.stringify(p.ledger.map((l) => ({ ref: l.referenceId, delta: l.delta })))} memberships=${p.memberships.length} skip=${p.skip}`,
      );

  if (!db) return;
  const result = {
    members: 0,
    memberships: 0,
    ledgerApplied: 0,
    ledgerExisting: 0,
    snapshots: 0,
    pointsWritten: 0,
  };
  try {
    for (const p of plans) {
      if (p.skip) continue;
      await importOne(db, args.shop!, p, memberTag, now, result);
    }
    for (const m of extra) {
      await importMemberOnly(db, args.shop!, m, memberTag, now);
      result.members++;
      result.memberships += m.subscriptions.length;
    }
  } finally {
    await db.prisma.$disconnect();
  }
  console.log("\nApplied");
  console.table(result);
}

async function openDb() {
  // 只在 --apply 时才加载 Prisma（dry-run 完全不碰数据库）
  const { default: prisma } = await import("../../app/db.server");
  const ledger = await import("../../app/models/ledger.server");
  const membership = await import("../../app/models/membership.server");
  return { prisma, ...ledger, upsertMemberships: membership.upsertMemberships };
}

type Db = Awaited<ReturnType<typeof openDb>>;

async function upsertMember(
  db: Db,
  shop: string,
  gid: string,
  m: ImportPlan["member"],
  hasRecord: boolean,
  subs: ExportMember["subscriptions"],
  memberTag: string,
  now: Date,
) {
  const contact = Object.fromEntries(
    Object.entries({
      email: m.email,
      phone: m.phone,
      firstName: m.firstName,
      lastName: m.lastName,
    }).filter(([, v]) => v),
  ) as Record<string, string>;
  const member = isMember({ tags: m.tags, memberships: subs }, now, memberTag);
  // 只有带了会员文件（标签 + 合约）才算「已同步会员资格」；只有积分行时留空，第一单时 earn 任务会去 Shopify 查
  const membershipFields = hasRecord
    ? {
        tags: m.tags,
        membershipSyncedAt: now,
        tier: member ? "paid" : "standard",
        paidUntil: member ? paidUntilFrom(subs, now) : null,
      }
    : {};
  return db.prisma.$transaction(async (tx) => {
    const row = await tx.member.upsert({
      where: { shopifyCustomerId: gid },
      create: {
        shopifyCustomerId: gid,
        shopDomain: shop,
        source: "appstle_migrated",
        ...contact,
        ...membershipFields,
      },
      update: { ...contact, ...membershipFields },
    });
    if (subs.length)
      await db.upsertMemberships(tx, row.id, subs, {
        expireMissingAppstle: false,
      });
    return row;
  });
}

async function importOne(
  db: Db,
  shop: string,
  p: ImportPlan,
  memberTag: string,
  now: Date,
  result: Record<string, number>,
) {
  const row = await upsertMember(
    db,
    shop,
    p.customerGid,
    p.member,
    p.hasMemberRecord,
    p.memberships,
    memberTag,
    now,
  );
  result.members++;
  result.memberships += p.memberships.length;
  await db.withMemberLock(row.id, async (tx) => {
    let availableLedgerId: string | null = null;
    for (const l of p.ledger) {
      const r = await db.insertLedger(tx, {
        memberId: row.id,
        delta: l.delta,
        type: "migrate",
        referenceType: "appstle_snapshot",
        referenceId: l.referenceId,
        note: l.note,
        availableAt: l.availableAt,
        createdBy: "system",
        meta: { flags: p.flags, kind: l.kind },
      });
      if (r.applied) {
        result.ledgerApplied++;
        result.pointsWritten += l.delta;
      } else result.ledgerExisting++;
      if (l.kind === "available") availableLedgerId = r.row?.id ?? null;
    }
    // 快照：原样留底（只有 Appstle 原始 JSON + flags + 迁移数，不含邮箱）；已存在就不覆盖，只补 ledgerId
    const snap = await tx.migrationSnapshot.findUnique({
      where: {
        source_shopifyCustomerId: {
          source: "appstle_loyalty",
          shopifyCustomerId: p.customerGid,
        },
      },
    });
    if (!snap) {
      await tx.migrationSnapshot.create({
        data: {
          shopifyCustomerId: p.customerGid,
          source: "appstle_loyalty",
          raw: {
            appstle: p.raw as Prisma.InputJsonObject,
            flags: p.flags,
            availablePoints: p.availablePoints,
            pendingPoints: p.pendingPoints,
          },
          ledgerId: availableLedgerId,
        },
      });
      result.snapshots++;
    } else if (!snap.ledgerId && availableLedgerId) {
      await tx.migrationSnapshot.update({
        where: { id: snap.id },
        data: { ledgerId: availableLedgerId },
      });
    }
  });
}

async function importMemberOnly(
  db: Db,
  shop: string,
  m: ExportMember,
  memberTag: string,
  now: Date,
) {
  await upsertMember(
    db,
    shop,
    m.shopifyCustomerId,
    {
      email: m.email,
      phone: m.phone,
      firstName: m.firstName,
      lastName: m.lastName,
      tags: m.tags,
    },
    true,
    m.subscriptions,
    memberTag,
    now,
  );
}

main().catch((e: unknown) => {
  console.error("[import] failed:", (e as Error).message);
  process.exit(1);
});
