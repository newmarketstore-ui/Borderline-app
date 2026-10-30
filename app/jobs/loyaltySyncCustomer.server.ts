// loyalty.sync_customer：customers/update → 刷新已是会员的人的姓名 / 邮箱 / 手机 / 标签；
//   已是会员、或标签里出现会员标签（刚入会）→ 排队 loyalty.sync_membership 去拉 appstle_membership.subscriptions。
// loyalty.sync_membership：拉客户标签 + Appstle 会员 metafield，upsert Membership（幂等，按合约 id）。
// loyalty.sync_balance：把余额镜像写到客户 metafield borderline.points_balance。
import type { WebhookEvent } from "@prisma/client";

import prisma from "../db.server";
import { hasMemberTag } from "../lib/membership";
import { customerFromRest } from "../lib/shopifyPayload";
import { getAdminForShop, getLoyaltySettings, syncBalanceMetafield, type AdminGraphql } from "../models/loyalty.server";
import { syncMembershipForCustomer } from "../models/membership.server";
import { enqueue, QUEUES, type SyncBalanceJobData, type SyncMembershipJobData } from "./queue.server";

export async function handleSyncCustomer(event: WebhookEvent): Promise<string | void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const c = customerFromRest(event.payload as Record<string, any>);
  if (!c) return "skipped: payload has no customer id";
  const settings = await getLoyaltySettings(event.shopDomain);
  const member = await prisma.member.findUnique({ where: { shopifyCustomerId: c.gid } });
  const tagged = hasMemberTag(c.tags, settings.memberTag);
  if (member) {
    // customers/update 给的是完整当前资料，这里允许清空（顾客删了手机号就跟着删）
    await prisma.member.update({
      where: { id: member.id },
      data: {
        email: c.email,
        phone: c.phone,
        firstName: c.firstName,
        lastName: c.lastName,
        ...(c.tags ? { tags: c.tags } : {}),
      },
    });
  }
  if (member || tagged) {
    // 我们自己写余额 metafield 也会触发 customers/update；标签没变且 2 分钟内刚同步过就不再去拉会员资格（防止放大成一串无用请求）
    const sameTags = !c.tags || JSON.stringify([...c.tags].sort()) === JSON.stringify([...(member?.tags ?? [])].sort());
    const fresh = member?.membershipSyncedAt && Date.now() - member.membershipSyncedAt.getTime() < 2 * 60 * 1000;
    if (member && sameTags && fresh) return "membership synced <2 min ago and tags unchanged; skipped";
    await enqueue(QUEUES.syncMembership, { shop: event.shopDomain, customerGid: c.gid }, {}, 10_000);
    return member ? undefined : "new member tag seen; membership sync queued";
  }
  return "skipped: not a member";
}

export async function handleSyncMembership(
  data: SyncMembershipJobData,
  deps: { getAdmin: (shop: string) => Promise<AdminGraphql> } = { getAdmin: getAdminForShop },
): Promise<void> {
  const settings = await getLoyaltySettings(data.shop);
  const admin = await deps.getAdmin(data.shop);
  await syncMembershipForCustomer(data.shop, admin, data.customerGid, {
    memberTag: settings.memberTag,
    createIfMember: true,
    source: "customer_update",
  });
}

export async function handleSyncBalance(data: SyncBalanceJobData): Promise<void> {
  const admin = await getAdminForShop(data.shop);
  await syncBalanceMetafield(admin, data.memberId);
}
