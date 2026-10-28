// GDPR 三条必备 webhook 的处理（gdpr.process）。
// - customers/data_request：统计我们存了这位客户什么，记在事件备注里；导出给商家目前手工做（在 /app/loyalty 打开会员页）。
// - customers/redact：抹掉会员的个人资料（邮箱 / 手机 / 姓名），清掉 Appstle 快照和含该客户的原始 webhook payload；
//   积分流水是财务记录，保留（不含个人资料，只有 Customer GID 关联）。
// - shop/redact：卸载 48 小时后 Shopify 发来，删掉该店全部会员数据和 webhook 记录。
import type { WebhookEvent } from "@prisma/client";

import prisma from "../db.server";
import { gid } from "../lib/shopifyPayload";

const REDACTED = { redacted: true };

export async function handleGdpr(event: WebhookEvent): Promise<string | void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 外部 JSON
  const p = event.payload as Record<string, any>;
  switch (event.topic) {
    case "customers/data_request":
      return dataRequest(p);
    case "customers/redact":
      return redactCustomer(event, p);
    case "shop/redact":
      return redactShop(event);
    default:
      throw new Error(`gdpr.process got unexpected topic ${event.topic}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dataRequest(p: Record<string, any>) {
  if (!p.customer?.id) return "data_request: no customer id in payload";
  const customerGid = gid("Customer", p.customer.id);
  const member = await prisma.member.findUnique({
    where: { shopifyCustomerId: customerGid },
    include: { _count: { select: { ledger: true, redemptions: true } } },
  });
  if (!member) return `data_request ${customerGid}: no loyalty data stored`;
  return `data_request ${customerGid}: member ${member.id}, ${member._count.ledger} ledger rows, ${member._count.redemptions} redemptions — export manually from /app/loyalty/${member.id}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function redactCustomer(event: WebhookEvent, p: Record<string, any>) {
  if (!p.customer?.id) return "redact: no customer id in payload";
  const customerGid = gid("Customer", p.customer.id);
  const numericId = Number(p.customer.id);

  const member = await prisma.member.updateMany({
    where: { shopifyCustomerId: customerGid },
    data: { email: null, phone: null, firstName: null, lastName: null },
  });
  const snaps = await prisma.migrationSnapshot.updateMany({
    where: { shopifyCustomerId: customerGid },
    data: { raw: REDACTED },
  });
  // 原始 payload 里带这个客户的：订单类（payload.customer.id）和 customers/update（payload.id）
  const byOrder = await prisma.webhookEvent.updateMany({
    where: { shopDomain: event.shopDomain, payload: { path: ["customer", "id"], equals: numericId } },
    data: { payload: REDACTED },
  });
  const byCustomer = await prisma.webhookEvent.updateMany({
    where: { shopDomain: event.shopDomain, topic: "customers/update", payload: { path: ["id"], equals: numericId } },
    data: { payload: REDACTED },
  });
  // 本事件自己的 payload 也含邮箱 / 手机，只留 ID
  await prisma.webhookEvent.update({ where: { id: event.id }, data: { payload: { customer: { id: numericId } } } });
  return `redacted ${customerGid}: member ${member.count}, snapshots ${snaps.count}, webhook payloads ${byOrder.count + byCustomer.count}`;
}

async function redactShop(event: WebhookEvent) {
  const shop = event.shopDomain;
  const members = await prisma.member.findMany({ where: { shopDomain: shop }, select: { shopifyCustomerId: true } });
  const ids = members.map((m) => m.shopifyCustomerId);
  const snaps = await prisma.migrationSnapshot.deleteMany({ where: { shopifyCustomerId: { in: ids } } });
  const deleted = await prisma.member.deleteMany({ where: { shopDomain: shop } }); // 流水 / 兑换级联删除
  await prisma.loyaltyConfig.deleteMany({ where: { shopDomain: shop } });
  const events = await prisma.webhookEvent.deleteMany({ where: { shopDomain: shop, id: { not: event.id } } });
  return `shop redact ${shop}: ${deleted.count} members, ${snaps.count} snapshots, ${events.count} webhook events deleted`;
}
