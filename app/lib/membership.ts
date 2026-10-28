// 付费会员判断 + Appstle Memberships metafield 解析。纯函数，无 I/O（任务、导入脚本、单测共用）。
// 会员 = 客户标签含 memberTag（默认 gold-membership，Appstle Memberships 打的标）
//        或 任一条 Membership status = active 且 endsAt 为空或晚于 asOf。
// Appstle 的 active 合约即使 nextBillingDate 已过也照 active 算（续费失败时 Appstle 自己会改状态 / 去标签）。

export type MembershipStatus = "active" | "cancelled" | "expired";
export type MembershipLike = { status: string; endsAt?: Date | string | null };

export type ParsedMembership = {
  source: "appstle";
  externalId: string;
  planName: string | null;
  status: MembershipStatus;
  startedAt: Date | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  raw: Record<string, unknown>;
};

export const APPSTLE_MEMBERSHIP_METAFIELD = { namespace: "appstle_membership", key: "subscriptions" } as const;

const norm = (s: string) => s.trim().toLowerCase();

/** REST 的 "a, b, c" / GraphQL 的 string[] / CSV 的 "a|b" → 去空去重的标签数组。 */
export function parseTagList(v: unknown, separator: RegExp = /,/): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(separator) : [];
  return Array.from(new Set(list.map((t) => t.trim()).filter(Boolean)));
}

export function hasMemberTag(tags: string[] | null | undefined, memberTag: string): boolean {
  const want = norm(memberTag);
  return Boolean(want) && (tags ?? []).some((t) => norm(t) === want);
}

export function membershipActive(m: MembershipLike, asOf: Date): boolean {
  if (m.status !== "active") return false;
  if (!m.endsAt) return true;
  return new Date(m.endsAt).getTime() > asOf.getTime();
}

export function isMember(
  member: { tags?: string[] | null; memberships?: MembershipLike[] | null },
  asOf: Date,
  memberTag = "gold-membership",
): boolean {
  if (hasMemberTag(member.tags, memberTag)) return true;
  return (member.memberships ?? []).some((m) => membershipActive(m, asOf));
}

export function mapAppstleStatus(s: unknown): MembershipStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "active") return "active";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  return "expired"; // paused / failed / expired / 未知 → 不算有效
}

const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** appstle_membership.subscriptions 的 value（JSON 字符串或已解析数组）→ Membership 行。 */
export function parseAppstleSubscriptions(value: unknown): ParsedMembership[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ParsedMembership[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.id === undefined || it.id === null || it.id === "") continue;
    const planNames = Array.isArray(it.sellingPlanNames) ? it.sellingPlanNames.map(String).filter(Boolean) : [];
    const planName =
      planNames.join("; ") ||
      (typeof it.membershipTier === "string" ? it.membershipTier : "") ||
      (Array.isArray(it.variantNames) ? it.variantNames.map(String).join("; ") : "") ||
      null;
    const status = mapAppstleStatus(it.status);
    out.push({
      source: "appstle",
      externalId: String(it.id),
      planName,
      status,
      startedAt: date(it.membershipStartDate),
      renewsAt: date(it.nextBillingDate),
      endsAt: null, // Appstle 不给结束日；取消后 status 变 cancelled
      raw: it,
    });
  }
  return out;
}

/** 会员到期日（显示 / Member.paidUntil 用）：有效合约里最晚的续费日。 */
export function paidUntilFrom(memberships: Array<MembershipLike & { renewsAt?: Date | string | null }>, asOf: Date) {
  let best: Date | null = null;
  for (const m of memberships) {
    if (!membershipActive(m, asOf)) continue;
    const d = date(m.endsAt ?? m.renewsAt ?? null);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/**
 * 赚分门槛（loyalty.earn 用）：earnRequiresMember 关掉时谁都赚；开着时只认会员。
 * member 为 null = 我们还不认识这个客户（没有 Member 行或从没同步过会员资格），调用方应先同步再判断。
 */
export function earnGate(
  settings: { earnRequiresMember: boolean; memberTag: string },
  member: { tags?: string[] | null; memberships?: MembershipLike[] | null } | null,
  asOf: Date,
): { eligible: boolean; reason: "rule_off" | "member" | "not_member" | "unknown" } {
  if (!settings.earnRequiresMember) return { eligible: true, reason: "rule_off" };
  if (!member) return { eligible: false, reason: "unknown" };
  return isMember(member, asOf, settings.memberTag)
    ? { eligible: true, reason: "member" }
    : { eligible: false, reason: "not_member" };
}
