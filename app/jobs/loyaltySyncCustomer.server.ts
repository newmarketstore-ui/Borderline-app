// loyalty.sync_customer：customers/update → 只刷新已是会员的人的姓名 / 邮箱 / 手机（不为每个客户都建会员）。
// loyalty.sync_balance：把余额镜像写到客户 metafield borderline.points_balance。
import type { WebhookEvent } from "@prisma/client";

import prisma from "../db.server";
import { customerFromRest } from "../lib/shopifyPayload";
import { getAdminForShop, syncBalanceMetafield } from "../models/loyalty.server";
import type { SyncBalanceJobData } from "./queue.server";

export async function handleSyncCustomer(event: WebhookEvent): Promise<string | void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const c = customerFromRest(event.payload as Record<string, any>);
  if (!c) return "skipped: payload has no customer id";
  const member = await prisma.member.findUnique({ where: { shopifyCustomerId: c.gid } });
  if (!member) return "skipped: not a member";
  // customers/update 给的是完整当前资料，这里允许清空（顾客删了手机号就跟着删）
  await prisma.member.update({
    where: { id: member.id },
    data: { email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName },
  });
}

export async function handleSyncBalance(data: SyncBalanceJobData): Promise<void> {
  const admin = await getAdminForShop(data.shop);
  await syncBalanceMetafield(admin, data.memberId);
}
