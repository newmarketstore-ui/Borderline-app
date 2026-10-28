// loyalty.earn 的门槛分支单测：服务层（Prisma / Shopify）全部换成桩，只测任务本身的判断。
// 重点：买会员的那一单（orders/paid 先于 gold-membership 标签到达）照样按会员给分，并排 2 分钟后的会员同步。
import type { WebhookEvent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ledger: [] as Array<Record<string, unknown>>,
  productTags: {} as Record<string, string[]>,
  gateMember: null as unknown,
  members: [] as Array<Record<string, unknown>>,
}));

vi.mock("../models/loyalty.server", () => ({
  ORDER_FOR_EARN_QUERY: "query LoyaltyOrderForEarn",
  getAdminForShop: vi.fn(),
  gql: vi.fn(),
  getLoyaltySettings: vi.fn(async () => ({
    pointsPerDollar: 1,
    excludedProductTypes: [],
    excludedTags: ["Gift Card", "Service"],
    earnOnShipping: false,
    earnOnTax: false,
    pendingDays: 0,
    paidTierMultiplier: 1,
    earnRequiresMember: true,
    memberTag: "gold-membership",
    excludeDiscountedItems: true,
  })),
  tierMultiplier: () => 1,
  enrichLinesWithProductInfo: vi.fn(async (_admin: unknown, lines: Array<{ productId?: string | null }>) =>
    lines.map((l) => ({ ...l, productType: "Thing", tags: (l.productId && h.productTags[l.productId]) || [] })),
  ),
  upsertMemberFromCustomer: vi.fn(async (_shop: string, c: { gid: string }) => {
    const m = { id: `member-${c.gid}`, shopifyCustomerId: c.gid, tier: "standard", paidUntil: null };
    h.members.push(m);
    return m;
  }),
  appendLedger: vi.fn(async (entry: Record<string, unknown>) => {
    h.ledger.push(entry);
    return { applied: true, member: { id: entry.memberId } };
  }),
}));

vi.mock("../models/membership.server", () => ({
  getMemberForGate: vi.fn(async () => h.gateMember),
  syncMembershipForCustomer: vi.fn(async () => h.gateMember),
}));

vi.mock("../models/redemption.server", () => ({
  markRedemptionUsed: vi.fn(async () => ({ used: 0, late: 0 })),
}));

vi.mock("./queue.server", () => ({
  QUEUES: { syncBalance: "loyalty.sync_balance", syncMembership: "loyalty.sync_membership" },
  enqueue: vi.fn(),
}));

import { handleEarn, MEMBERSHIP_SYNC_DELAY_SECONDS, type EarnDeps } from "./loyaltyEarn.server";

const CUSTOMER = "gid://shopify/Customer/42";

function orderEvent(lines: Array<{ id: number; product_id: number; price: string }>): WebhookEvent {
  return {
    id: "ev1",
    webhookId: "wh1",
    topic: "orders/paid",
    shopDomain: "test.myshopify.com",
    payload: {
      id: 1001,
      admin_graphql_api_id: "gid://shopify/Order/1001",
      name: "#1001",
      processed_at: "2026-10-28T12:00:00Z",
      customer: { id: 42, admin_graphql_api_id: CUSTOMER },
      line_items: lines.map((l) => ({ ...l, quantity: 1, gift_card: false, discount_allocations: [], tax_lines: [] })),
      shipping_lines: [],
    },
    receivedAt: new Date(),
    processedAt: null,
    status: "queued",
    error: null,
  };
}

function deps() {
  const syncMembership: Array<{ shop: string; customerGid: string; delaySeconds: number }> = [];
  const d: EarnDeps = {
    getAdmin: async () => ({ graphql: async () => new Response("{}") }),
    enqueueSyncBalance: async () => null,
    enqueueSyncMembership: async (shop, customerGid, delaySeconds) => {
      syncMembership.push({ shop, customerGid, delaySeconds });
    },
  };
  return { d, syncMembership };
}

const nonMember = { id: "m1", tags: ["newsletter"], memberships: [], membershipSyncedAt: new Date() };

describe("handleEarn member gate", () => {
  beforeEach(() => {
    h.ledger = [];
    h.members = [];
    h.productTags = {};
    h.gateMember = null;
  });

  it("non-member without a membership product earns nothing and queues no sync", async () => {
    h.gateMember = nonMember;
    h.productTags = { "gid://shopify/Product/1": ["Jacket"] };
    const { d, syncMembership } = deps();
    const note = await handleEarn(orderEvent([{ id: 1, product_id: 1, price: "120.00" }]), d);
    expect(note).toMatch(/not a paying member/);
    expect(h.ledger).toHaveLength(0);
    expect(syncMembership).toHaveLength(0);
  });

  it("order containing a Membership product earns as a member and queues a delayed membership sync", async () => {
    h.gateMember = nonMember; // Appstle 还没打 gold-membership 标签
    h.productTags = { "gid://shopify/Product/1": ["Jacket"], "gid://shopify/Product/50": ["Membership"] };
    const { d, syncMembership } = deps();
    const note = await handleEarn(
      orderEvent([
        { id: 1, product_id: 1, price: "120.00" },
        { id: 2, product_id: 50, price: "50.00" },
      ]),
      d,
    );
    expect(note).toMatch(/membership purchase/);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ type: "earn", delta: 170, referenceId: "gid://shopify/Order/1001" });
    expect((h.ledger[0].meta as Record<string, unknown>).membershipPurchase).toBe(true);
    expect(syncMembership).toEqual([
      { shop: "test.myshopify.com", customerGid: CUSTOMER, delaySeconds: MEMBERSHIP_SYNC_DELAY_SECONDS },
    ]);
    expect(MEMBERSHIP_SYNC_DELAY_SECONDS).toBe(120);
  });

  it("unknown customer (never synced, not a member yet) buying the membership also earns", async () => {
    h.gateMember = null; // sync 返回 null：Shopify 上还没有会员标签 / 合约
    h.productTags = { "gid://shopify/Product/50": ["membership"] };
    const { d, syncMembership } = deps();
    await handleEarn(orderEvent([{ id: 2, product_id: 50, price: "50.00" }]), d);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].delta).toBe(50);
    expect(syncMembership).toHaveLength(1);
  });

  it("existing member earns without the membership shortcut", async () => {
    h.gateMember = { ...nonMember, tags: ["gold-membership"] };
    h.productTags = { "gid://shopify/Product/1": ["Jacket"] };
    const { d, syncMembership } = deps();
    const note = await handleEarn(orderEvent([{ id: 1, product_id: 1, price: "80.00" }]), d);
    expect(note).toBeUndefined();
    expect(h.ledger[0].delta).toBe(80);
    expect(syncMembership).toHaveLength(0);
  });
});
