// Appstle 导出 → 我们的数据：纯映射函数（scripts/loyalty/importAppstle.ts 用，单测也用）。
// 输入文件（含个人资料，只在本机 backups/loyalty-migration/<时间戳>/，绝不进仓库）：
//   migrate_rows.jsonl     {shopifyCustomerId, email, availablePoints, pendingPoints, flags[], raw}
//   customers_bulk.jsonl   Admin bulk 导出，每行一个客户：tags[]、msub.value = appstle_membership.subscriptions（推荐）
//   customers_loyalty.csv  一行一个客户；tags 用 | 分隔；会员合约只有汇总列（合约 id 用 | 分隔）
import { mapAppstleStatus, parseAppstleSubscriptions, parseTagList, type ParsedMembership } from "./membership";

export type MigrateRow = {
  shopifyCustomerId: string;
  email: string | null;
  availablePoints: number;
  pendingPoints: number;
  flags: string[];
  raw: Record<string, unknown>;
};

export type ExportMember = {
  shopifyCustomerId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  tags: string[];
  subscriptions: ParsedMembership[];
};

export type PlannedLedger = {
  kind: "available" | "pending";
  referenceId: string;
  delta: number;
  availableAt: Date;
  note: string;
};

export type ImportPlan = {
  customerGid: string;
  numericId: string;
  flags: string[];
  skip: null | "anomaly_huge_balance";
  availablePoints: number;
  pendingPoints: number;
  ledger: PlannedLedger[];
  member: { email: string | null; phone: string | null; firstName: string | null; lastName: string | null; tags: string[] };
  memberships: ParsedMembership[];
  hasMemberRecord: boolean;
  raw: Record<string, unknown>; // Appstle 原始 customer_loyalty JSON（存进 MigrationSnapshot）
};

const DAY_MS = 24 * 60 * 60 * 1000;
const s = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim();

export const customerGid = (id: unknown) => {
  const v = String(id ?? "").trim();
  return v.startsWith("gid://") ? v : `gid://shopify/Customer/${v}`;
};
export const numericCustomerId = (id: unknown) => customerGid(id).split("/").pop() ?? "";

const floorPoints = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

export function parseMigrateRows(text: string): MigrateRow[] {
  const rows: MigrateRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    rows.push({
      shopifyCustomerId: customerGid(o.shopifyCustomerId),
      email: s(o.email),
      availablePoints: Number(o.availablePoints) || 0,
      pendingPoints: Number(o.pendingPoints) || 0,
      flags: Array.isArray(o.flags) ? o.flags.map(String) : [],
      raw: (o.raw && typeof o.raw === "object" ? o.raw : {}) as Record<string, unknown>,
    });
  }
  return rows;
}

/** RFC 4180 CSV（双引号转义、字段内换行、BOM）。 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.length > 1 || r[0] !== "");
}

/** customers_loyalty.csv 一行（表头 → 值）。合约只有汇总列：每个合约 id 一条，状态 / 计划 / 日期共用。 */
export function memberFromCsvRow(r: Record<string, string>): ExportMember {
  const ids = (r.membership_contract_ids ?? "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
  const statuses = (r.membership_statuses ?? "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
  const start = s(r.membership_start);
  const next = s(r.membership_next_billing);
  const subscriptions: ParsedMembership[] = ids.map((id, i) => ({
    source: "appstle",
    externalId: id,
    planName: s(r.membership_plan),
    status: mapAppstleStatus(statuses[i] ?? statuses[0]),
    startedAt: start ? new Date(start) : null,
    renewsAt: next ? new Date(next) : null,
    endsAt: null,
    raw: { fromCsv: true, contractId: id, status: statuses[i] ?? statuses[0] ?? null, plan: s(r.membership_plan) },
  }));
  return {
    shopifyCustomerId: customerGid(r.shopifyCustomerId),
    email: s(r.email),
    phone: s(r.phone),
    firstName: s(r.firstName),
    lastName: s(r.lastName),
    tags: parseTagList(r.tags ?? "", /\|/),
    subscriptions,
  };
}

export function membersFromCsv(text: string): Map<string, ExportMember> {
  const [header, ...rows] = parseCsv(text);
  const map = new Map<string, ExportMember>();
  if (!header) return map;
  const keys = header.map((h) => h.trim());
  for (const cells of rows) {
    const rec = Object.fromEntries(keys.map((h, i) => [h, cells[i] ?? ""]));
    if (!rec.shopifyCustomerId) continue;
    const m = memberFromCsvRow(rec);
    map.set(m.shopifyCustomerId, m);
  }
  return map;
}

/** customers_bulk.jsonl 一行（Admin bulk：id / email / phone / firstName / lastName / tags[] / msub{value}）。 */
export function memberFromBulk(o: Record<string, unknown>): ExportMember | null {
  if (!o || !o.id || "__parentId" in o) return null;
  const msub = o.msub as { value?: unknown } | null | undefined;
  return {
    shopifyCustomerId: customerGid(o.id),
    email: s(o.email),
    phone: s(o.phone),
    firstName: s(o.firstName),
    lastName: s(o.lastName),
    tags: parseTagList(o.tags),
    subscriptions: msub?.value ? parseAppstleSubscriptions(msub.value) : [],
  };
}

export function membersFromBulkJsonl(text: string): Map<string, ExportMember> {
  const map = new Map<string, ExportMember>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = memberFromBulk(JSON.parse(line));
    if (m) map.set(m.shopifyCustomerId, m);
  }
  return map;
}

/**
 * 一行迁移数据 → 要写的东西。可用积分 / 待定积分各写一条 migrate 流水（向下取整，可为负），
 * 幂等键 appstle:<数字 ID> / appstle:<数字 ID>:pending；待定积分按 pendingDays 推迟生效（0 = 立即）。
 */
export function planImportRow(
  row: MigrateRow,
  member: ExportMember | undefined,
  opts: { includeAnomalies: boolean; pendingDays: number; now: Date; multiplier?: number },
): ImportPlan {
  // Appstle 10 分 = $1，我们 100 分 = $1：旧分 × multiplier（默认 1；导入脚本按规则传 10）保值
  const multiplier = opts.multiplier ?? 1;
  const gidv = customerGid(row.shopifyCustomerId);
  const id = numericCustomerId(gidv);
  const anomaly = row.flags.includes("anomaly_huge_balance");
  const available = floorPoints(Number(row.availablePoints) * multiplier);
  const pending = floorPoints(Number(row.pendingPoints) * multiplier);
  const scaleNote = multiplier !== 1 ? ` (x${multiplier})` : "";
  const ledger: PlannedLedger[] = [];
  if (available !== 0)
    ledger.push({
      kind: "available",
      referenceId: `appstle:${id}`,
      delta: available,
      availableAt: opts.now,
      note: `Appstle balance migrated${scaleNote}`,
    });
  if (pending !== 0)
    ledger.push({
      kind: "pending",
      referenceId: `appstle:${id}:pending`,
      delta: pending,
      availableAt: opts.pendingDays > 0 ? new Date(opts.now.getTime() + opts.pendingDays * DAY_MS) : opts.now,
      note: `Appstle pending points migrated${scaleNote}`,
    });
  return {
    customerGid: gidv,
    numericId: id,
    flags: row.flags,
    skip: anomaly && !opts.includeAnomalies ? "anomaly_huge_balance" : null,
    availablePoints: available,
    pendingPoints: pending,
    ledger,
    member: {
      email: member?.email ?? row.email,
      phone: member?.phone ?? null,
      firstName: member?.firstName ?? null,
      lastName: member?.lastName ?? null,
      tags: member?.tags ?? [],
    },
    memberships: member?.subscriptions ?? [],
    hasMemberRecord: Boolean(member),
    raw: row.raw,
  };
}

export type ImportSummary = {
  rows: number;
  planned: number;
  skippedAnomaly: number;
  withMemberRecord: number;
  memberTagged: number;
  membershipRows: number;
  activeMemberships: number;
  ledgerRows: number;
  availablePoints: number;
  pendingPoints: number;
  negativeRows: number;
  negativePoints: number;
  flags: Record<string, number>;
};

export function summarizePlans(plans: ImportPlan[], memberTag: string): ImportSummary {
  const tag = memberTag.trim().toLowerCase();
  const sum: ImportSummary = {
    rows: plans.length,
    planned: 0,
    skippedAnomaly: 0,
    withMemberRecord: 0,
    memberTagged: 0,
    membershipRows: 0,
    activeMemberships: 0,
    ledgerRows: 0,
    availablePoints: 0,
    pendingPoints: 0,
    negativeRows: 0,
    negativePoints: 0,
    flags: {},
  };
  for (const p of plans) {
    for (const f of p.flags) sum.flags[f] = (sum.flags[f] ?? 0) + 1;
    if (p.skip) {
      sum.skippedAnomaly++;
      continue;
    }
    sum.planned++;
    if (p.hasMemberRecord) sum.withMemberRecord++;
    if (p.member.tags.some((t) => t.toLowerCase() === tag)) sum.memberTagged++;
    sum.membershipRows += p.memberships.length;
    sum.activeMemberships += p.memberships.filter((m) => m.status === "active").length;
    sum.ledgerRows += p.ledger.length;
    sum.availablePoints += p.availablePoints;
    sum.pendingPoints += p.pendingPoints;
    if (p.availablePoints < 0) {
      sum.negativeRows++;
      sum.negativePoints += p.availablePoints;
    }
  }
  return sum;
}
