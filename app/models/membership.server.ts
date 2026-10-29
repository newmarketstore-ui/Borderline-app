// 付费会员资格同步：从 Shopify 拉客户标签 + appstle_membership.subscriptions，落到 Member.tags / Membership。
// 幂等：Membership 按 (source, externalId) upsert；重复跑结果一样。
// 触发：customers/update（loyalty.sync_membership 任务）、loyalty.earn 遇到「会员身份未知」时当场调用、店员页「Refresh」。
import type { Member, Membership, Prisma } from "@prisma/client";

import prisma from "../db.server";
import {
  APPSTLE_MEMBERSHIP_METAFIELD,
  isMember,
  paidUntilFrom,
  parseAppstleSubscriptions,
  parseTagList,
  type ParsedMembership,
} from "../lib/membership";
import type { OrderCustomer } from "../lib/shopifyPayload";
import type { AdminGraphql } from "./loyalty.server";

export type MemberWithMemberships = Member & { memberships: Membership[] };

export const CUSTOMER_MEMBERSHIP_QUERY = `#graphql
  query LoyaltyCustomerMembership($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      tags
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
      appstle: metafield(namespace: "${APPSTLE_MEMBERSHIP_METAFIELD.namespace}", key: "${APPSTLE_MEMBERSHIP_METAFIELD.key}") {
        value
        updatedAt
      }
    }
  }`;

type CustomerMembershipData = {
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    tags: string[];
    defaultEmailAddress: { emailAddress: string | null } | null;
    defaultPhoneNumber: { phoneNumber: string | null } | null;
    appstle: { value: string | null; updatedAt: string | null } | null;
  } | null;
};

export type FetchedMembership = {
  customer: OrderCustomer;
  tags: string[];
  subscriptions: ParsedMembership[];
};

export async function fetchCustomerMembership(admin: AdminGraphql, customerGid: string): Promise<FetchedMembership | null> {
  const resp = await admin.graphql(CUSTOMER_MEMBERSHIP_QUERY, { variables: { id: customerGid } });
  const json = (await resp.json()) as { data?: CustomerMembershipData; errors?: unknown };
  if (json.errors) throw new Error(`Admin GraphQL error: ${JSON.stringify(json.errors).slice(0, 500)}`);
  const c = json.data?.customer;
  if (!c) return null;
  const tags = parseTagList(c.tags);
  return {
    customer: {
      gid: c.id,
      email: c.defaultEmailAddress?.emailAddress ?? null,
      phone: c.defaultPhoneNumber?.phoneNumber ?? null,
      firstName: c.firstName,
      lastName: c.lastName,
      tags,
    },
    tags,
    subscriptions: parseAppstleSubscriptions(c.appstle?.value ?? null),
  };
}

const contact = (c: Partial<OrderCustomer>) =>
  Object.fromEntries(
    Object.entries({ email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName }).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  ) as Record<string, string>;

/**
 * 把一次拉到的会员资料写库。
 * - 已有 Member：更新标签 / 联系方式 / Membership，标 membershipSyncedAt。
 * - 没有 Member：只有 createIfMember 且确实是会员时才建（不为每个下单的非会员都建会员行）。
 * - 这次列表里没有了的 Appstle 合约若仍是 active → 改 expired（metafield 被清掉的情况）。
 */
export async function applyMembership(
  shop: string,
  data: FetchedMembership,
  opts: { memberTag: string; createIfMember: boolean; source?: string; now?: Date },
): Promise<MemberWithMemberships | null> {
  const now = opts.now ?? new Date();
  const existing = await prisma.member.findUnique({ where: { shopifyCustomerId: data.customer.gid } });
  const member = isMember({ tags: data.tags, memberships: data.subscriptions }, now, opts.memberTag);
  if (!existing && !(opts.createIfMember && member)) return null;

  const paidUntil = paidUntilFrom(data.subscriptions, now);
  return prisma.$transaction(async (tx) => {
    const base: Prisma.MemberUncheckedUpdateInput = {
      ...contact(data.customer),
      tags: data.tags,
      membershipSyncedAt: now,
      tier: member ? "paid" : "standard",
      paidUntil: member ? paidUntil : null,
    };
    const row = existing
      ? await tx.member.update({ where: { id: existing.id }, data: base })
      : await tx.member.create({
          data: {
            ...contact(data.customer),
            shopifyCustomerId: data.customer.gid,
            shopDomain: shop,
            source: opts.source ?? "membership_sync",
            tags: data.tags,
            membershipSyncedAt: now,
            tier: member ? "paid" : "standard",
            paidUntil: member ? paidUntil : null,
          },
        });
    await upsertMemberships(tx, row.id, data.subscriptions, { expireMissingAppstle: true });
    return tx.member.findUniqueOrThrow({ where: { id: row.id }, include: { memberships: true } });
  });
}

/** Membership upsert（导入脚本也用）。expireMissingAppstle：这次没出现的 active Appstle 合约 → expired。 */
export async function upsertMemberships(
  tx: Prisma.TransactionClient,
  memberId: string,
  list: ParsedMembership[],
  opts: { expireMissingAppstle: boolean },
) {
  for (const m of list) {
    const data = {
      planName: m.planName,
      status: m.status,
      startedAt: m.startedAt,
      renewsAt: m.renewsAt,
      endsAt: m.endsAt,
      raw: m.raw as Prisma.InputJsonValue,
    };
    await tx.membership.upsert({
      where: { source_externalId: { source: m.source, externalId: m.externalId } },
      create: { memberId, source: m.source, externalId: m.externalId, ...data },
      update: { memberId, ...data },
    });
  }
  if (opts.expireMissingAppstle) {
    await tx.membership.updateMany({
      where: {
        memberId,
        source: "appstle",
        status: "active",
        externalId: { notIn: list.filter((m) => m.source === "appstle").map((m) => m.externalId) },
      },
      data: { status: "expired" },
    });
  }
}

/** 拉 + 写，一步到位。客户在 Shopify 不存在（已删）时返回 null。 */
export async function syncMembershipForCustomer(
  shop: string,
  admin: AdminGraphql,
  customerGid: string,
  opts: { memberTag: string; createIfMember: boolean; source?: string },
): Promise<MemberWithMemberships | null> {
  const data = await fetchCustomerMembership(admin, customerGid);
  if (!data) return null;
  return applyMembership(shop, data, opts);
}

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

/**
 * 买了会员商品（标签 Membership）→ 我们自己记一份付费会员：Membership(source shopify_order, externalId 订单 GID)，
 * tier = paid，paidUntil = max(现有到期日, 现在) + membershipMonths。幂等：同一订单只记一份。
 */
export async function grantPurchasedMembership(params: {
  memberId: string;
  orderGid: string;
  orderName?: string | null;
  months: number;
  at: Date;
}): Promise<MemberWithMemberships> {
  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUniqueOrThrow({ where: { id: params.memberId } });
    const existing = await tx.membership.findUnique({
      where: { source_externalId: { source: "shopify_order", externalId: params.orderGid } },
    });
    if (!existing) {
      const base = member.paidUntil && member.paidUntil > params.at ? member.paidUntil : params.at;
      const endsAt = new Date(base.getTime() + params.months * MONTH_MS);
      await tx.membership.create({
        data: {
          memberId: member.id,
          source: "shopify_order",
          externalId: params.orderGid,
          planName: `Store Membership (${params.orderName ?? params.orderGid})`,
          status: "active",
          startedAt: params.at,
          endsAt,
        },
      });
      await tx.member.update({ where: { id: member.id }, data: { tier: "paid", paidUntil: endsAt } });
    }
    return tx.member.findUniqueOrThrow({ where: { id: member.id }, include: { memberships: true } });
  });
}

export async function getMemberForGate(customerGid: string): Promise<MemberWithMemberships | null> {
  return prisma.member.findUnique({ where: { shopifyCustomerId: customerGid }, include: { memberships: true } });
}
