// Webhook 落库 + 入队。原则：先落库（WebhookEvent，webhookId 唯一去重）再异步处理，Shopify 重发不会重复记账。
import type { Prisma, WebhookEvent } from "@prisma/client";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { enqueue, QUEUES, type QueueName } from "../jobs/queue.server";
import { isUniqueViolation } from "./loyalty.server";

// X-Shopify-Topic → 处理任务；null = 只落库不处理（orders/create）
export const JOB_FOR_TOPIC: Record<string, QueueName | null> = {
  "orders/paid": QUEUES.earn,
  "orders/create": null,
  "refunds/create": QUEUES.refundReverse,
  "customers/update": QUEUES.syncCustomer,
  "customers/data_request": QUEUES.gdpr,
  "customers/redact": QUEUES.gdpr,
  "shop/redact": QUEUES.gdpr,
};

/**
 * 每个 webhook 路由的 action 都调它：
 * 1. authenticate.webhook 校验 HMAC（不通过会直接抛 401 Response）
 * 2. 插 WebhookEvent；webhookId 重复（Shopify 重发）→ 直接 200
 * 3. 入队（3 秒超时）；入队失败也回 200，事件留在 received，sweep 任务 10 分钟内补
 */
export async function landWebhook(request: Request): Promise<Response> {
  const ctx = await authenticate.webhook(request);
  const topic = (request.headers.get("x-shopify-topic") ?? String(ctx.topic)).toLowerCase();
  const job = JOB_FOR_TOPIC[topic] ?? null;

  let event: WebhookEvent;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        webhookId: ctx.webhookId,
        topic,
        shopDomain: ctx.shop,
        payload: (ctx.payload ?? {}) as Prisma.InputJsonValue,
        status: job ? "received" : "done",
        processedAt: job ? null : new Date(),
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return new Response(null, { status: 200 });
    throw e;
  }

  if (job) {
    try {
      await enqueue(job, { eventId: event.id });
      // 只从 received 改成 queued：worker 可能已经抢先处理完（done），不能倒回去
      await prisma.webhookEvent.updateMany({ where: { id: event.id, status: "received" }, data: { status: "queued" } });
    } catch (e) {
      console.error(`[webhook] enqueue failed for ${topic} (${event.id}); sweep will retry:`, (e as Error).message);
    }
  }
  return new Response(null, { status: 200 });
}

/**
 * 任务里处理一个事件：已 done 的跳过；成功置 done（handler 可返回一句备注，比如 "skipped: no customer"，存在 error 列）；
 * 失败置 failed 并抛出，让 pg-boss 按队列配置重试，重试成功会再置回 done。
 */
export async function processEvent(eventId: string, handler: (event: WebhookEvent) => Promise<string | void>) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event || event.status === "done") return;
  try {
    const note = await handler(event);
    await prisma.webhookEvent.updateMany({
      where: { id: eventId },
      data: { status: "done", processedAt: new Date(), error: note ? note.slice(0, 1000) : null },
    });
  } catch (e) {
    await prisma.webhookEvent.updateMany({
      where: { id: eventId },
      data: { status: "failed", error: ((e as Error).message ?? String(e)).slice(0, 1000) },
    });
    throw e;
  }
}
