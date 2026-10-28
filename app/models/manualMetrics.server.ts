import type { ManualDailyMetric } from "@prisma/client";
import prisma from "../db.server";
import { CHANNELS } from "../lib/channels";
import {
  calculateUnknown,
  validateManualMetric,
  type ManualMetricInput,
} from "../lib/metricValidation";

// Date 等非 JSON 值转成可写入 Json 列的纯对象
function toJson(obj: unknown) {
  return JSON.parse(JSON.stringify(obj));
}

function inputToChannelColumns(input: ManualMetricInput): Record<string, number> {
  const cols: Record<string, number> = {};
  for (const c of CHANNELS) cols[c.field] = Number(input.channels[c.key]) || 0;
  cols.channelUnknown = calculateUnknown(input);
  return cols;
}

// Prisma 行 → 对外 channels 映射（含 unknown）
export function rowToChannels(row: ManualDailyMetric): Record<string, number> {
  const channels: Record<string, number> = {};
  for (const c of CHANNELS) channels[c.key] = ((row as unknown as Record<string, number | null>)[c.field] ?? 0);
  channels.unknown = row.channelUnknown ?? 0;
  return channels;
}

const uniqueWhere = (shopDomain: string, businessDate: string, locationId: string) => ({
  shopDomain_businessDate_locationId: { shopDomain, businessDate, locationId },
});

export async function getManualMetric(params: {
  shopDomain: string;
  businessDate: string;
  locationId: string;
}) {
  return prisma.manualDailyMetric.findUnique({
    where: uniqueWhere(params.shopDomain, params.businessDate, params.locationId),
  });
}

export type UpsertResult =
  | { ok: true; metric: ManualDailyMetric }
  | { ok: false; errors: string[] };

export async function upsertManualMetric(params: {
  shopDomain: string;
  input: ManualMetricInput;
  actorName?: string | null;
  actorEmail?: string | null;
}): Promise<UpsertResult> {
  const { shopDomain, input } = params;

  const errors = validateManualMetric(input);
  if (errors.length) return { ok: false, errors };

  const data = {
    shopDomain,
    businessDate: input.businessDate,
    locationId: input.locationId,
    locationName: input.locationName ?? null,
    storeVisitGroups: Number(input.storeVisitGroups) || 0,
    ...inputToChannelColumns(input),
    trafficFactors: input.trafficFactors ?? [],
    notes: input.notes?.trim() || null,
    submittedByName: params.actorName ?? input.recordedBy?.trim() ?? null,
    submittedByEmail: params.actorEmail ?? null,
  };

  const existing = await getManualMetric({
    shopDomain,
    businessDate: input.businessDate,
    locationId: input.locationId,
  });

  const saved = await prisma.manualDailyMetric.upsert({
    where: uniqueWhere(shopDomain, input.businessDate, input.locationId),
    create: data,
    update: data,
  });

  // 审计：每次 create/update 都记录前后值
  await prisma.manualDailyMetricAudit.create({
    data: {
      metricId: saved.id,
      action: existing ? "update" : "create",
      beforeJson: existing ? toJson(existing) : undefined,
      afterJson: toJson(saved),
      actorName: params.actorName ?? input.recordedBy?.trim() ?? null,
      actorEmail: params.actorEmail ?? null,
    },
  });

  return { ok: true, metric: saved };
}

export async function listManualMetrics(params: {
  shopDomain: string;
  fromDate: string;
  toDate: string;
  locationId?: string | null;
}) {
  return prisma.manualDailyMetric.findMany({
    where: {
      shopDomain: params.shopDomain,
      businessDate: { gte: params.fromDate, lte: params.toDate },
      ...(params.locationId ? { locationId: params.locationId } : {}),
    },
    orderBy: [{ businessDate: "desc" }, { locationName: "asc" }],
  });
}
