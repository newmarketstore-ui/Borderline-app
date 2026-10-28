import { CHANNELS } from "./channels";
import { isValidDate } from "./dates";

export type ChannelCounts = Record<string, number>; // 按 channels.ts 的 key

export type ManualMetricInput = {
  businessDate: string;
  locationId: string;
  locationName?: string | null;
  storeVisitGroups: number;
  channels: ChannelCounts;
  trafficFactors: string[];
  notes?: string | null;
  recordedBy?: string | null;
};

export function knownChannelTotal(channels: ChannelCounts): number {
  return CHANNELS.reduce((sum, c) => sum + (Number(channels[c.key]) || 0), 0);
}

// unknown 永远由服务端计算，绝不信任前端传入的值
export function calculateUnknown(input: ManualMetricInput): number {
  const groups = Number(input.storeVisitGroups) || 0;
  return Math.max(0, groups - knownChannelTotal(input.channels));
}

export function validateManualMetric(input: ManualMetricInput): string[] {
  const errors: string[] = [];

  if (!isValidDate(input.businessDate)) errors.push("日期必须是 YYYY-MM-DD");
  if (!input.locationId || !input.locationId.trim()) errors.push("必须选择门店");

  const intChecks: Array<[string, unknown]> = [
    ["到店组数", input.storeVisitGroups],
    ...CHANNELS.map((c) => [c.label, input.channels[c.key]] as [string, unknown]),
  ];
  for (const [label, raw] of intChecks) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      errors.push(`「${label}」必须是 ≥0 的整数`);
    }
  }

  if (knownChannelTotal(input.channels) > (Number(input.storeVisitGroups) || 0)) {
    errors.push("各渠道组数合计不能大于到店总组数（差额会记为未知来源）");
  }

  return errors;
}
