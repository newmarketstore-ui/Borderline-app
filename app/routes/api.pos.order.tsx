// POS 收尾屏：GET /api/pos/order?orderId=<数字或 GID>
// 不等 webhook：当场按这张订单记账（幂等，webhook 后到也不会重复），返回这单赚了多少、余额多少。
import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { handleEarn } from "../jobs/loyaltyEarn.server";
import { processEvent } from "../models/webhookEvents.server";
import { authenticate } from "../shopify.server";

const orderGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Order/${id.replace(/\D/g, "")}`);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const raw = new URL(request.url).searchParams.get("orderId");
  if (!raw) return cors(Response.json({ error: "orderId required" }, { status: 400 }));
  const gid = orderGid(raw);
  const numeric = Number(gid.split("/").pop());

  // 已经记过（webhook 先到）→ 直接答
  let earn = await prisma.pointsLedger.findUnique({
    where: { type_referenceId: { type: "earn", referenceId: gid } },
    include: { member: true },
  });
  if (!earn) {
    // 造一条「来自 POS 收尾屏」的事件：payload 没有 line_items，handleEarn 会用 Admin API 拉整单
    const event = await prisma.webhookEvent.upsert({
      where: { webhookId: `pos-post-purchase:${gid}` },
      create: {
        webhookId: `pos-post-purchase:${gid}`,
        topic: "orders/paid",
        shopDomain: session.shop,
        payload: { id: numeric, admin_graphql_api_id: gid, source: "pos-post-purchase" },
        status: "queued",
      },
      update: {},
    });
    await processEvent(event.id, handleEarn);
    earn = await prisma.pointsLedger.findUnique({
      where: { type_referenceId: { type: "earn", referenceId: gid } },
      include: { member: true },
    });
  }
  if (!earn) {
    const ev = await prisma.webhookEvent.findUnique({ where: { webhookId: `pos-post-purchase:${gid}` } });
    return cors(Response.json({ earned: 0, reason: ev?.error ?? "no points for this order", balance: null }));
  }
  return cors(
    Response.json({
      earned: earn.delta,
      orderName: earn.orderName,
      balance: earn.member.balanceCached,
      pending: earn.member.pendingCached,
      tier: earn.member.tier,
      memberId: earn.member.id,
    }),
  );
};
