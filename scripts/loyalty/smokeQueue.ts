// pg-boss 端到端冒烟：只许连本机库（verifyLocal.ts 会起一个一次性库并把 DATABASE_URL 只放进子进程环境）。
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/loyalty_dev npx tsx scripts/loyalty/smokeQueue.ts
//
// 真 pg-boss + 真 Prisma + 真任务代码；只有 Shopify Admin API 换成桩。覆盖：
//   1. orders/paid 会员（身份未知 → 桩 Admin 拿到 gold-membership）→ earn 120；同一订单重发 → 不重复记
//   2. orders/paid 非会员 → 不记分、不建 Member
//   3. orders/paid 非会员买会员商品（标签 Membership）→ 照样记分 + loyalty.sync_membership 延迟 2 分钟入队
//   4. refunds/create 退一半 → refund_reverse −60；同一退款重发 → 不重复扣
//   5. 兑换：issueRedemption（桩 Admin 建码）→ Redemption + redeem 流水；表单键重放只发一张；周三 POS 窗口 ×2 + 最低消费 = 折扣额
//   6. sweep 跑一次 → 过期未用的码停用 + redeem_release 退分；未过期的不动
//   7. 订单用了兑换码 → Redemption 标 used
// 输出只有计数 / 积分，没有任何邮箱或凭证。
import { randomUUID } from "node:crypto";

import { assertLocalUrl } from "./localDb";

assertLocalUrl(process.env.DATABASE_URL);
if (process.env.PGBOSS_DATABASE_URL)
  assertLocalUrl(process.env.PGBOSS_DATABASE_URL);
// shopify.server 在 import 时初始化，给它占位值（不会真的调 Shopify：Admin API 全部走下面的桩）
process.env.SHOPIFY_API_KEY ||= "smoke-test-key";
process.env.SHOPIFY_API_SECRET ||= "smoke-test-secret";
process.env.SHOPIFY_APP_URL ||= "http://localhost:3000";
process.env.SCOPES ||= "read_orders";
process.env.JOBS_DISABLED = "1";

const SHOP = "smoke-test.myshopify.com";
const RUN = Date.now();
const cust = (n: number) => `gid://shopify/Customer/9${n}${RUN}`;
const MEMBER_A = cust(1); // 会员（Shopify 上有 gold-membership 标签 + Appstle 合约）
const NON_MEMBER_B = cust(2);
const BUYER_C = cust(3); // 正在买会员（标签还没打上）
const orderNo = (n: number) => Number(`7${n}${RUN}`);

// ── Admin GraphQL 桩 ─────────────────────────────────────────────────────────
const calls = {
  discountCreate: [] as Array<Record<string, unknown>>,
  deactivate: [] as string[],
  storeCreditCredit: [] as Array<Record<string, unknown>>,
  storeCreditDebit: [] as Array<Record<string, unknown>>,
};
let discountSeq = 0;
let storeCreditSeq = 0;
let storeCreditCents = 0;
const PRODUCT_TAGS: Record<string, string[]> = {
  "gid://shopify/Product/1": [],
  "gid://shopify/Product/2": ["Service"],
  "gid://shopify/Product/3": [],
  "gid://shopify/Product/50": ["Membership"],
};
const stubAdmin = {
  graphql: async (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => {
    const v = options?.variables ?? {};
    const body = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      });
    if (query.includes("LoyaltyCustomerMembership")) {
      const isA = v.id === MEMBER_A;
      return body({
        customer: {
          id: v.id,
          firstName: "Smoke",
          lastName: "Test",
          tags: isA ? ["gold-membership"] : ["newsletter"],
          defaultEmailAddress: null,
          defaultPhoneNumber: null,
          appstle: isA
            ? {
                value: JSON.stringify([
                  {
                    id: 1,
                    sellingPlanNames: ["Annual Membership"],
                    status: "active",
                  },
                ]),
                updatedAt: null,
              }
            : null,
        },
      });
    }
    if (query.includes("LoyaltyProductInfo")) {
      const ids = (v.ids as string[]) ?? [];
      return body({
        nodes: ids.map((id) => ({
          id,
          productType: "Thing",
          tags: PRODUCT_TAGS[id] ?? [],
        })),
      });
    }
    if (query.includes("LoyaltyRedeemCodeCreate")) {
      calls.discountCreate.push(v.input as Record<string, unknown>);
      return body({
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: `gid://shopify/DiscountCodeNode/${++discountSeq}${RUN}`,
          },
          userErrors: [],
        },
      });
    }
    if (query.includes("LoyaltyStoreCreditCredit")) {
      calls.storeCreditCredit.push(v.input as Record<string, unknown>);
      storeCreditCents += Math.round(Number((v.input as { creditAmount: { amount: string } }).creditAmount.amount) * 100);
      return body({
        storeCreditAccountCredit: {
          storeCreditAccountTransaction: {
            id: `gid://shopify/StoreCreditAccountCreditTransaction/${++storeCreditSeq}${RUN}`,
            account: { id: `gid://shopify/StoreCreditAccount/1${RUN}`, balance: { amount: (storeCreditCents / 100).toFixed(2), currencyCode: "CAD" } },
          },
          userErrors: [],
        },
      });
    }
    if (query.includes("LoyaltyStoreCreditDebit")) {
      calls.storeCreditDebit.push(v.input as Record<string, unknown>);
      storeCreditCents -= Math.round(Number((v.input as { debitAmount: { amount: string } }).debitAmount.amount) * 100);
      return body({
        storeCreditAccountDebit: {
          storeCreditAccountTransaction: {
            id: `gid://shopify/StoreCreditAccountDebitTransaction/${++storeCreditSeq}${RUN}`,
            account: { id: `gid://shopify/StoreCreditAccount/1${RUN}`, balance: { amount: (storeCreditCents / 100).toFixed(2), currencyCode: "CAD" } },
          },
          userErrors: [],
        },
      });
    }
    if (query.includes("LoyaltyRedeemCodeUsage")) {
      return body({
        codeDiscountNode: {
          id: v.id,
          codeDiscount: { asyncUsageCount: 0, status: "ACTIVE" },
        },
      });
    }
    if (query.includes("LoyaltyRedeemCodeDeactivate")) {
      calls.deactivate.push(String(v.id));
      return body({
        discountCodeDeactivate: {
          codeDiscountNode: { id: v.id },
          userErrors: [],
        },
      });
    }
    throw new Error(`smoke stub: unexpected Admin query ${query.slice(0, 80)}`);
  },
};

// ── 假 payload ───────────────────────────────────────────────────────────────
type Line = {
  id: number;
  product_id: number;
  quantity?: number;
  price: string;
  discount?: string;
};
function orderPayload(
  n: number,
  customerGid: string,
  lines: Line[],
  discountCodes: string[] = [],
) {
  const id = orderNo(n);
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#SMOKE${n}`,
    test: false,
    taxes_included: false,
    processed_at: new Date().toISOString(),
    discount_codes: discountCodes.map((code) => ({
      code,
      amount: "1.00",
      type: "fixed_amount",
    })),
    customer: {
      id: Number(customerGid.split("/").pop()),
      admin_graphql_api_id: customerGid,
      first_name: "Smoke",
    },
    line_items: lines.map((l) => ({
      id: l.id,
      product_id: l.product_id,
      gift_card: false,
      quantity: l.quantity ?? 1,
      price: l.price,
      discount_allocations: l.discount ? [{ amount: l.discount }] : [],
      tax_lines: [],
    })),
    shipping_lines: [
      { price: "15.00", discount_allocations: [], tax_lines: [] },
    ],
  };
}

// 会员订单：2 × $60.25 = $120.50 → 120 分；Service 行、打折行不计；运费不计
const ORDER_A = orderPayload(1, MEMBER_A, [
  { id: 1, product_id: 1, quantity: 2, price: "60.25" },
  { id: 2, product_id: 2, price: "40.00" },
  { id: 3, product_id: 3, price: "30.00", discount: "3.00" },
]);
const ORDER_B = orderPayload(2, NON_MEMBER_B, [
  { id: 11, product_id: 1, price: "80.00" },
]);
const ORDER_C = orderPayload(3, BUYER_C, [
  { id: 21, product_id: 50, price: "50.00" },
  { id: 22, product_id: 1, price: "20.00" },
]);
const REFUND_ID = Number(`8${RUN}`);
const REFUND_HALF = {
  id: REFUND_ID,
  admin_graphql_api_id: `gid://shopify/Refund/${REFUND_ID}`,
  order_id: ORDER_A.id,
  refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: "60.25" }],
  order_adjustments: [],
};

// ── 断言 ─────────────────────────────────────────────────────────────────────
const failures: string[] = [];
let passed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) passed++;
  else
    failures.push(
      `${name}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  console.log(
    `[smoke] ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`,
  );
}

async function main() {
  const { default: prisma } = await import("../../app/db.server");
  const { getBoss, enqueue, QUEUES } =
    await import("../../app/jobs/queue.server");
  const { processEvent } =
    await import("../../app/models/webhookEvents.server");
  const { handleEarn, defaultEarnDeps } =
    await import("../../app/jobs/loyaltyEarn.server");
  const { handleRefundReverse } =
    await import("../../app/jobs/loyaltyRefund.server");
  const { handleSweep } = await import("../../app/jobs/sweep.server");
  const { appendLedger } = await import("../../app/models/ledger.server");
  const { issueRedemption, reverseStoreCredit } =
    await import("../../app/models/redemption.server");

  const boss = await getBoss();
  const eventIds: string[] = [];
  const earnDeps = {
    ...defaultEarnDeps,
    getAdmin: async () => stubAdmin,
    enqueueSyncBalance: async () => null,
  };
  const work = (queue: string, handler: Parameters<typeof processEvent>[1]) =>
    boss.work<{ eventId: string }>(
      queue,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        await processEvent(job.data.eventId, handler);
      },
    );

  async function deliver(
    topic: string,
    queue: (typeof QUEUES)[keyof typeof QUEUES],
    payload: object,
  ) {
    const event = await prisma.webhookEvent.create({
      data: {
        webhookId: `smoke-${randomUUID()}`,
        topic,
        shopDomain: SHOP,
        payload,
        status: "received",
      },
    });
    eventIds.push(event.id);
    await enqueue(queue, { eventId: event.id });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      if (row.status === "done" || row.status === "failed") return row;
      await new Promise((r) => setTimeout(r, 250));
    }
    return prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } });
  }
  const member = (gid: string) =>
    prisma.member.findUnique({
      where: { shopifyCustomerId: gid },
      include: { memberships: true },
    });
  const ledgerOf = (memberId: string, type: string) =>
    prisma.pointsLedger.findMany({ where: { memberId, type } });

  // 第 1–7 段沿用 Appstle 旧规则（这些检查写于 10/28）：会员才赚、1 倍、打折行不计、折扣码 10 分 = $1 含税、最低 500 步长 100。
  // 第 8 段切到老板 10/29 新规则（默认值）：人人 1 分/$、付费 10 分/$、100 分 = $1 Store Credit。
  const legacyRules = {
    shopDomain: SHOP,
    redeemPointsPerDollar: 10,
    minRedeemPoints: 500,
    redeemStepPoints: 100,
    paidTierMultiplier: 1,
    earnRequiresMember: true,
    excludeDiscountedItems: true,
    redeemMethod: "discount_code",
    redeemAmountIsTaxInclusive: true,
    redeemRequiresMember: true,
    updatedBy: "smoke",
  };
  await prisma.loyaltyConfig.upsert({ where: { shopDomain: SHOP }, create: legacyRules, update: legacyRules });
  // 规则行一落库，默认的「周三双倍」窗口就不再自动生效，这里显式建一条（第 6 段的周三检查要用）
  await prisma.redeemWindow.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.redeemWindow.create({
    data: {
      shopDomain: SHOP,
      label: "Double Redeem Every Wednesday",
      dayOfWeek: 3,
      startHour: null,
      endHour: null,
      timezone: "America/Toronto",
      multiplier: 2,
      channels: ["pos"],
      memberOnly: true,
      active: true,
      minSpendEqualsDiscount: true,
    },
  });

  try {
    await work(QUEUES.earn, (e) => handleEarn(e, earnDeps));
    await work(QUEUES.refundReverse, handleRefundReverse);

    // 1. 会员订单
    const evA = await deliver("orders/paid", QUEUES.earn, ORDER_A);
    const earnA = await prisma.pointsLedger.findUnique({
      where: {
        type_referenceId: {
          type: "earn",
          referenceId: ORDER_A.admin_graphql_api_id,
        },
      },
    });
    let a = await member(MEMBER_A);
    check("member order: event done", evA.status === "done", {
      status: evA.status,
      note: evA.error,
    });
    check("member order: earn 120", earnA?.delta === 120, earnA?.delta);
    check(
      "member order: balance 120, tier paid, 1 membership",
      a?.balanceCached === 120 &&
        a.tier === "paid" &&
        a.memberships.length === 1,
      {
        balance: a?.balanceCached,
        tier: a?.tier,
        memberships: a?.memberships.length,
      },
    );

    // 1b. 同一订单重发（新的 webhookId）
    const evA2 = await deliver("orders/paid", QUEUES.earn, ORDER_A);
    a = await member(MEMBER_A);
    const earnRowsA = a ? (await ledgerOf(a.id, "earn")).length : -1;
    check(
      "member order redelivered: idempotent",
      evA2.status === "done" && earnRowsA === 1 && a?.balanceCached === 120,
      {
        note: evA2.error,
        earnRowsA,
      },
    );

    // 2. 非会员订单
    const evB = await deliver("orders/paid", QUEUES.earn, ORDER_B);
    const earnB = await prisma.pointsLedger.count({
      where: { type: "earn", referenceId: ORDER_B.admin_graphql_api_id },
    });
    check(
      "non-member order: done, no earn, no Member row",
      evB.status === "done" && earnB === 0 && !(await member(NON_MEMBER_B)),
      {
        note: evB.error,
        earnB,
      },
    );

    // 3. 非会员买会员商品
    const before = Date.now();
    const evC = await deliver("orders/paid", QUEUES.earn, ORDER_C);
    const c = await member(BUYER_C);
    const earnC = await prisma.pointsLedger.findUnique({
      where: {
        type_referenceId: {
          type: "earn",
          referenceId: ORDER_C.admin_graphql_api_id,
        },
      },
    });
    check(
      "membership purchase: earn 70 as member",
      evC.status === "done" && earnC?.delta === 70 && c?.balanceCached === 70,
      {
        note: evC.error,
        delta: earnC?.delta,
      },
    );
    const syncJobs = await prisma.$queryRawUnsafe<
      Array<{ data: { customerGid?: string }; start_after: Date }>
    >(
      `SELECT data, start_after FROM pgboss.job WHERE name = $1`,
      QUEUES.syncMembership,
    );
    const syncC = syncJobs.filter((j) => j.data?.customerGid === BUYER_C);
    const delayS = syncC.length
      ? (new Date(syncC[0].start_after).getTime() - before) / 1000
      : null;
    check(
      "membership purchase: sync_membership queued ~120 s later",
      syncC.length === 1 && delayS !== null && delayS >= 100 && delayS <= 150,
      {
        jobs: syncC.length,
        delayS,
      },
    );

    // 4. 退一半
    const evR = await deliver(
      "refunds/create",
      QUEUES.refundReverse,
      REFUND_HALF,
    );
    a = await member(MEMBER_A);
    const rev = a ? await ledgerOf(a.id, "refund_reverse") : [];
    check(
      "refund half: refund_reverse -60, balance 60",
      evR.status === "done" &&
        rev.length === 1 &&
        rev[0].delta === -60 &&
        a?.balanceCached === 60,
      {
        note: evR.error,
        deltas: rev.map((r) => r.delta),
        balance: a?.balanceCached,
      },
    );
    const evR2 = await deliver(
      "refunds/create",
      QUEUES.refundReverse,
      REFUND_HALF,
    );
    const rev2 = a ? await ledgerOf(a.id, "refund_reverse") : [];
    check(
      "refund redelivered: idempotent",
      evR2.status === "done" && rev2.length === 1,
      { note: evR2.error, rows: rev2.length },
    );

    // 5. 兑换
    if (!a) throw new Error("member A missing");
    await appendLedger({
      memberId: a.id,
      delta: 1000,
      type: "adjust",
      referenceType: "staff_adjust",
      referenceId: `staff_adjust:smoke-${RUN}`,
      note: "smoke top-up",
      createdBy: "smoke",
    });
    const key1 = randomUUID();
    const r1 = await issueRedemption(
      {
        memberId: a.id,
        points: 500,
        channel: "web",
        issuedBy: "smoke",
        idempotencyKey: key1,
      },
      { getAdmin: async () => stubAdmin },
    );
    a = await member(MEMBER_A);
    const redeemRows = await ledgerOf(a!.id, "redeem");
    check(
      "redemption (web): issued with discount id, $44.25",
      r1.ok &&
        r1.redemption.status === "issued" &&
        Boolean(r1.redemption.discountCodeId) &&
        r1.redemption.amountCents === 4425,
      r1.ok ? { amount: r1.redemption.amountCents } : r1.error,
    );
    check(
      "redemption (web): redeem ledger -500 ref redemption:<id>, balance 560",
      r1.ok &&
        redeemRows.length === 1 &&
        redeemRows[0].delta === -500 &&
        redeemRows[0].referenceId === `redemption:${r1.redemption.id}` &&
        a?.balanceCached === 560,
      { rows: redeemRows.length, balance: a?.balanceCached },
    );
    check(
      "redemption (web): no minimum requirement",
      calls.discountCreate.length === 1 &&
        !("minimumRequirement" in calls.discountCreate[0]),
    );
    const r1b = await issueRedemption(
      {
        memberId: a!.id,
        points: 500,
        channel: "web",
        issuedBy: "smoke",
        idempotencyKey: key1,
      },
      { getAdmin: async () => stubAdmin },
    );
    check(
      "redemption replay (same form key): same code, nothing new",
      r1b.ok &&
        !r1b.applied &&
        r1.ok &&
        r1b.redemption.id === r1.redemption.id &&
        (await ledgerOf(a!.id, "redeem")).length === 1 &&
        calls.discountCreate.length === 1,
    );

    // 周三 POS（多伦多 2026-10-21 中午）：×2 → $88.50，最低订单 = $88.50；24 小时有效 → 现在已过期
    const r2 = await issueRedemption(
      {
        memberId: a!.id,
        points: 500,
        channel: "pos",
        issuedBy: "smoke",
        idempotencyKey: randomUUID(),
        at: new Date("2026-10-21T16:00:00Z"),
      },
      { getAdmin: async () => stubAdmin },
    );
    const input2 = calls.discountCreate[1] as {
      minimumRequirement?: unknown;
      customerGets?: { value?: { discountAmount?: { amount?: string } } };
    };
    check(
      "redemption (Wednesday POS): x2 = $88.50, min subtotal $88.50",
      r2.ok &&
        r2.redemption.amountCents === 8850 &&
        JSON.stringify(input2?.minimumRequirement) ===
          JSON.stringify({
            subtotal: { greaterThanOrEqualToSubtotal: "88.50" },
          }) &&
        input2?.customerGets?.value?.discountAmount?.amount === "88.50",
      {
        amount: r2.ok ? r2.redemption.amountCents : r2.error,
        min: input2?.minimumRequirement,
      },
    );
    a = await member(MEMBER_A);
    check(
      "redemption (Wednesday POS): balance 60",
      a?.balanceCached === 60,
      a?.balanceCached,
    );

    // 6. sweep
    await handleSweep({ getAdmin: async () => stubAdmin });
    const r2row = r2.ok
      ? await prisma.redemption.findUnique({ where: { id: r2.redemption.id } })
      : null;
    const r1row = r1.ok
      ? await prisma.redemption.findUnique({ where: { id: r1.redemption.id } })
      : null;
    const releases = await ledgerOf(a!.id, "redeem_release");
    a = await member(MEMBER_A);
    check(
      "sweep: expired redemption -> expired + deactivated",
      r2row?.status === "expired" &&
        calls.deactivate.length === 1 &&
        calls.deactivate[0] === r2row?.discountCodeId,
      {
        status: r2row?.status,
        deactivated: calls.deactivate.length,
      },
    );
    check(
      "sweep: redeem_release +500 for it, balance 560",
      releases.length === 1 &&
        releases[0].delta === 500 &&
        releases[0].referenceId === `redemption:${r2row?.id}` &&
        a?.balanceCached === 560,
      { releases: releases.map((r) => r.delta), balance: a?.balanceCached },
    );
    check(
      "sweep: unexpired redemption untouched",
      r1row?.status === "issued",
      r1row?.status,
    );

    // 7. 订单用了 r1 的码 → used（这一行有折扣分摊 → 不计分）
    const code1 = r1.ok ? r1.redemption.discountCode! : "";
    const evU = await deliver(
      "orders/paid",
      QUEUES.earn,
      orderPayload(
        4,
        MEMBER_A,
        [{ id: 31, product_id: 1, price: "60.00", discount: "44.25" }],
        [code1],
      ),
    );
    const r1used = r1.ok
      ? await prisma.redemption.findUnique({ where: { id: r1.redemption.id } })
      : null;
    check(
      "order with the code: redemption marked used",
      evU.status === "done" &&
        r1used?.status === "used" &&
        r1used.orderId === `gid://shopify/Order/${orderNo(4)}`,
      {
        note: evU.error,
        status: r1used?.status,
      },
    );

    // 8. 老板 10/29 新规则：删掉旧规则行 → 用默认值（人人 1 分/$、付费会员 10 分/$、1000 分 = $10 Store Credit）
    await prisma.loyaltyConfig.delete({ where: { shopDomain: SHOP } });
    const ORDER_B2 = orderPayload(5, NON_MEMBER_B, [{ id: 41, product_id: 1, price: "80.00" }]);
    const evB2 = await deliver("orders/paid", QUEUES.earn, ORDER_B2);
    const b2 = await member(NON_MEMBER_B);
    const earnB2 = await prisma.pointsLedger.findUnique({
      where: { type_referenceId: { type: "earn", referenceId: ORDER_B2.admin_graphql_api_id } },
    });
    check(
      "new rules: non-member with a profile earns 1 pt/$ (80)",
      evB2.status === "done" && earnB2?.delta === 80 && b2?.tier === "standard",
      { note: evB2.error, delta: earnB2?.delta, tier: b2?.tier },
    );
    const ORDER_A2 = orderPayload(6, MEMBER_A, [{ id: 51, product_id: 1, price: "80.00" }]);
    const evA2b = await deliver("orders/paid", QUEUES.earn, ORDER_A2);
    const earnA2 = await prisma.pointsLedger.findUnique({
      where: { type_referenceId: { type: "earn", referenceId: ORDER_A2.admin_graphql_api_id } },
    });
    check(
      "new rules: paid member earns 10 pt/$ (800)",
      evA2b.status === "done" && earnA2?.delta === 800,
      { note: evA2b.error, delta: earnA2?.delta },
    );
    a = await member(MEMBER_A);
    const balanceBeforeSC = a!.balanceCached;
    const keySC = randomUUID();
    const sc = await issueRedemption(
      { memberId: a!.id, points: 1000, channel: "pos", issuedBy: "smoke", idempotencyKey: keySC },
      { getAdmin: async () => stubAdmin },
    );
    a = await member(MEMBER_A);
    check(
      "store credit: 1000 pts -> $10.00 credited, transaction id saved, balance -1000",
      sc.ok &&
        sc.redemption.method === "store_credit" &&
        sc.redemption.status === "credited" &&
        sc.redemption.amountCents === 1000 &&
        Boolean(sc.redemption.storeCreditTransactionId) &&
        a?.balanceCached === balanceBeforeSC - 1000 &&
        calls.storeCreditCredit.length === 1 &&
        (calls.storeCreditCredit[0] as { notify?: boolean }).notify === true,
      sc.ok ? { status: sc.redemption.status, amount: sc.redemption.amountCents, balance: a?.balanceCached } : sc.error,
    );
    const scReplay = await issueRedemption(
      { memberId: a!.id, points: 1000, channel: "pos", issuedBy: "smoke", idempotencyKey: keySC },
      { getAdmin: async () => stubAdmin },
    );
    check(
      "store credit replay (same form key): nothing new credited",
      scReplay.ok && !scReplay.applied && calls.storeCreditCredit.length === 1,
    );
    const badStep = await issueRedemption(
      { memberId: a!.id, points: 1500, channel: "pos", issuedBy: "smoke", idempotencyKey: randomUUID() },
      { getAdmin: async () => stubAdmin },
    );
    check("store credit: 1500 pts rejected by the 1000-point step", !badStep.ok && /steps of 1000/.test(badStep.error));
    const scRev = sc.ok ? await reverseStoreCredit(sc.redemption.id, "smoke", "customer changed their mind", { getAdmin: async () => stubAdmin }) : { ok: false as const, error: "n/a" };
    a = await member(MEMBER_A);
    const scRow = sc.ok ? await prisma.redemption.findUnique({ where: { id: sc.redemption.id } }) : null;
    const scRelease = sc.ok ? await prisma.pointsLedger.findUnique({ where: { type_referenceId: { type: "redeem_release", referenceId: `redemption:${sc.redemption.id}` } } }) : null;
    check(
      "store credit reversed: debit called, status cancelled, 1000 pts returned",
      scRev.ok &&
        scRow?.status === "cancelled" &&
        Boolean(scRow?.storeCreditReversalId) &&
        scRelease?.delta === 1000 &&
        a?.balanceCached === balanceBeforeSC &&
        calls.storeCreditDebit.length === 1,
      { ok: scRev.ok, status: scRow?.status, balance: a?.balanceCached },
    );
    const scRev2 = sc.ok ? await reverseStoreCredit(sc.redemption.id, "smoke", "again", { getAdmin: async () => stubAdmin }) : { ok: true as const };
    check("store credit reverse replay: refused, no second debit", !scRev2.ok && calls.storeCreditDebit.length === 1);

    const totals = {
      members: await prisma.member.count({ where: { shopDomain: SHOP } }),
      ledgerRows: await prisma.pointsLedger.count({
        where: { member: { shopDomain: SHOP } },
      }),
      redemptions: await prisma.redemption.count({
        where: { member: { shopDomain: SHOP } },
      }),
      webhookEvents: eventIds.length,
    };
    console.log(`[smoke] totals ${JSON.stringify(totals)}`);
  } finally {
    // 清理（会员级联删流水 / 合约 / 兑换）
    await prisma.member
      .deleteMany({
        where: { shopifyCustomerId: { in: [MEMBER_A, NON_MEMBER_B, BUYER_C] } },
      })
      .catch(() => undefined);
    await prisma.webhookEvent
      .deleteMany({ where: { id: { in: eventIds } } })
      .catch(() => undefined);
    await prisma.loyaltyConfig.deleteMany({ where: { shopDomain: SHOP } }).catch(() => undefined);
    await prisma.redeemWindow.deleteMany({ where: { shopDomain: SHOP } }).catch(() => undefined);
    await boss.stop({ graceful: false, wait: true });
    await prisma.$disconnect();
  }
  console.log(`[smoke] ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`[smoke] FAILED: ${f}`);
    process.exit(1);
  }
  console.log("[smoke] OK");
}

main().catch((e: unknown) => {
  console.error("[smoke] error:", (e as Error).message);
  process.exit(1);
});
