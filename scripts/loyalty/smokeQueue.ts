// pg-boss 端到端冒烟：只许连本机库。启动 pg-boss → 落一条假的 orders/paid WebhookEvent → 入队 loyalty.earn →
// worker（Admin API 用桩）处理 → 断言写出了 earn 流水 → 清理测试数据 → 停 pg-boss。
//
//   DATABASE_URL=postgresql://postgres:postgres@localhost:<port>/loyalty_dev npx tsx scripts/loyalty/smokeQueue.ts
//
// 走的是「会员身份未知」路径：库里没有这个客户 → earn 任务调（桩）Admin API 拿到 gold-membership 标签 → 建会员 → 记分。
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "Set DATABASE_URL explicitly (local database only; .env is production)",
  );
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  throw new Error(
    `Refusing to run the smoke test against ${host}; only a local database is allowed`,
  );
}
// shopify.server 在 import 时初始化，给它占位值（不会真的调 Shopify：Admin API 全部走下面的桩）
process.env.SHOPIFY_API_KEY ||= "smoke-test-key";
process.env.SHOPIFY_API_SECRET ||= "smoke-test-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_orders";
process.env.JOBS_DISABLED = "1";

const SHOP = "smoke-test.myshopify.com";
const CUSTOMER_GID = `gid://shopify/Customer/9${Date.now()}`;
const ORDER_ID = Number(`7${Date.now()}`);

// Admin GraphQL 桩：按操作名回假数据
const stubAdmin = {
  graphql: async (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => {
    const body = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    if (query.includes("LoyaltyCustomerMembership")) {
      return body({
        customer: {
          id: options?.variables?.id,
          firstName: "Smoke",
          lastName: "Test",
          tags: ["gold-membership"],
          defaultEmailAddress: null,
          defaultPhoneNumber: null,
          appstle: {
            value: JSON.stringify([
              {
                id: 1,
                sellingPlanNames: ["Annual Membership"],
                status: "active",
              },
            ]),
            updatedAt: null,
          },
        },
      });
    }
    if (query.includes("LoyaltyProductInfo")) {
      const ids = (options?.variables?.ids as string[]) ?? [];
      return body({
        nodes: ids.map((id) => ({
          id,
          productType: "Jacket",
          tags: id.endsWith("/2") ? ["Service"] : [],
        })),
      });
    }
    throw new Error(`smoke stub: unexpected Admin query ${query.slice(0, 80)}`);
  },
};

const payload = {
  id: ORDER_ID,
  admin_graphql_api_id: `gid://shopify/Order/${ORDER_ID}`,
  name: "#SMOKE1",
  test: false,
  taxes_included: false,
  processed_at: new Date().toISOString(),
  discount_codes: [],
  customer: {
    id: Number(CUSTOMER_GID.split("/").pop()),
    admin_graphql_api_id: CUSTOMER_GID,
    first_name: "Smoke",
  },
  line_items: [
    // 计分：$120.50 → 120 分
    {
      id: 1,
      product_id: 1,
      gift_card: false,
      quantity: 1,
      price: "120.50",
      discount_allocations: [],
      tax_lines: [{ price: "15.67" }],
    },
    // Service 标签 → 不计
    {
      id: 2,
      product_id: 2,
      gift_card: false,
      quantity: 1,
      price: "40.00",
      discount_allocations: [],
      tax_lines: [],
    },
    // 打折行 → 不计
    {
      id: 3,
      product_id: 3,
      gift_card: false,
      quantity: 1,
      price: "30.00",
      discount_allocations: [{ amount: "3.00" }],
      tax_lines: [],
    },
  ],
  shipping_lines: [{ price: "15.00", discount_allocations: [], tax_lines: [] }],
};

async function main() {
  const { default: prisma } = await import("../../app/db.server");
  const { getBoss, enqueue, QUEUES } =
    await import("../../app/jobs/queue.server");
  const { processEvent } =
    await import("../../app/models/webhookEvents.server");
  const { handleEarn } = await import("../../app/jobs/loyaltyEarn.server");

  const boss = await getBoss();
  let failed = false;
  try {
    const event = await prisma.webhookEvent.create({
      data: {
        webhookId: `smoke-${randomUUID()}`,
        topic: "orders/paid",
        shopDomain: SHOP,
        payload,
        status: "received",
      },
    });
    await boss.work<{ eventId: string }>(
      QUEUES.earn,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        await processEvent(job.data.eventId, (e) =>
          handleEarn(e, {
            getAdmin: async () => stubAdmin,
            enqueueSyncBalance: async () => null,
            enqueueSyncMembership: async () => null,
          }),
        );
      },
    );
    await enqueue(QUEUES.earn, { eventId: event.id });

    const deadline = Date.now() + 30_000;
    let status = "received";
    while (Date.now() < deadline) {
      const row = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      status = row.status;
      if (status === "done" || status === "failed") {
        if (row.error) console.log(`[smoke] event note: ${row.error}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const ledger = await prisma.pointsLedger.findUnique({
      where: {
        type_referenceId: {
          type: "earn",
          referenceId: payload.admin_graphql_api_id,
        },
      },
    });
    const member = await prisma.member.findUnique({
      where: { shopifyCustomerId: CUSTOMER_GID },
      include: { memberships: true },
    });
    console.log(
      `[smoke] event status=${status}; earn delta=${ledger?.delta ?? "none"}; member tier=${member?.tier}; memberships=${member?.memberships.length}`,
    );
    if (
      status !== "done" ||
      ledger?.delta !== 120 ||
      member?.balanceCached !== 120 ||
      member.memberships.length !== 1
    ) {
      failed = true;
      console.error(
        "[smoke] FAILED: expected done / earn 120 / balance 120 / 1 membership",
      );
    } else console.log("[smoke] OK");

    // 清理（会员级联删流水 / 合约）
    await prisma.member.deleteMany({
      where: { shopifyCustomerId: CUSTOMER_GID },
    });
    await prisma.webhookEvent.delete({ where: { id: event.id } });
  } finally {
    await boss.stop({ graceful: false, wait: true });
    await prisma.$disconnect();
  }
  if (failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error("[smoke] error:", (e as Error).message);
  process.exit(1);
});
