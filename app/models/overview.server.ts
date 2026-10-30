// 首页总览的数据：积分项目 KPI + 系统健康 + 上线检查单。只读。
import prisma from "../db.server";
import { getLoyaltySettings } from "./loyalty.server";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Overview = {
  members: { total: number; paid: number; withBalance: number; newLast30d: number };
  points: { issued30d: number; redeemed30d: number; outstanding: number; expired30d: number };
  redemptions30d: { storeCredit: number; cartDiscount: number; discountCode: number; amountCents: number };
  webhooks: { last24h: number; failed24h: number; lastReceivedAt: string | null; lastTopic: string | null; pendingReceived: number };
  recentEvents: Array<{ at: string; topic: string; status: string; note: string | null }>;
  checklist: Array<{ key: string; label: string; ok: boolean; detail: string; href?: string }>;
  settingsSaved: boolean;
  imported: number;
};

export async function loadOverview(shop: string): Promise<Overview> {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const d1 = new Date(now.getTime() - DAY_MS);
  const memberWhere = { shopDomain: shop };

  const [total, paid, withBalance, newLast30d, settings, importedRows] = await Promise.all([
    prisma.member.count({ where: memberWhere }),
    prisma.member.count({ where: { ...memberWhere, tier: "paid", OR: [{ paidUntil: null }, { paidUntil: { gt: now } }] } }),
    prisma.member.count({ where: { ...memberWhere, balanceCached: { gt: 0 } } }),
    prisma.member.count({ where: { ...memberWhere, createdAt: { gte: d30 } } }),
    getLoyaltySettings(shop),
    prisma.migrationSnapshot.count(),
  ]);

  const ledger30 = await prisma.pointsLedger.groupBy({
    by: ["type"],
    where: { member: memberWhere, createdAt: { gte: d30 } },
    _sum: { delta: true },
  });
  const sum = (types: string[]) => ledger30.filter((r) => types.includes(r.type)).reduce((a, r) => a + (r._sum.delta ?? 0), 0);
  const outstandingAgg = await prisma.member.aggregate({ where: memberWhere, _sum: { balanceCached: true } });

  const red30 = await prisma.redemption.groupBy({
    by: ["method"],
    where: { member: memberWhere, createdAt: { gte: d30 }, status: { in: ["credited", "used", "issued"] } },
    _count: { _all: true },
    _sum: { amountCents: true },
  });
  const redCount = (m: string) => red30.find((r) => r.method === m)?._count._all ?? 0;

  const [last24h, failed24h, lastEvent, pendingReceived, recent] = await Promise.all([
    prisma.webhookEvent.count({ where: { shopDomain: shop, receivedAt: { gte: d1 } } }),
    prisma.webhookEvent.count({ where: { shopDomain: shop, receivedAt: { gte: d1 }, status: "failed" } }),
    prisma.webhookEvent.findFirst({ where: { shopDomain: shop }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, topic: true } }),
    prisma.webhookEvent.count({ where: { shopDomain: shop, status: "received", receivedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) } } }),
    prisma.webhookEvent.findMany({
      where: { shopDomain: shop },
      orderBy: { receivedAt: "desc" },
      take: 8,
      select: { receivedAt: true, topic: true, status: true, error: true },
    }),
  ]);

  const offline = await prisma.session.findFirst({ where: { shop, isOnline: false }, select: { scope: true } });
  const scopes = new Set((offline?.scope ?? "").split(",").map((s) => s.trim()));
  const needScopes = ["write_customers", "write_discounts", "write_store_credit_account_transactions", "read_orders"];
  const missing = needScopes.filter((s) => !scopes.has(s));

  const checklist: Overview["checklist"] = [
    {
      key: "scopes",
      label: "App permissions",
      ok: missing.length === 0,
      detail: missing.length ? `Missing: ${missing.join(", ")} (open the app and accept the update)` : "Customers, discounts, orders and store credit granted",
    },
    {
      key: "settings",
      label: "Points rules saved",
      ok: settings.persisted,
      detail: settings.persisted ? `Saved by ${settings.updatedBy ?? "staff"} on ${settings.updatedAt?.slice(0, 10)}` : "Using defaults until someone saves the settings once",
      href: "/app/loyalty/settings",
    },
    {
      key: "webhooks",
      label: "Order webhooks arriving",
      ok: Boolean(lastEvent),
      detail: lastEvent ? `Last ${lastEvent.topic} at ${lastEvent.receivedAt.toISOString().replace("T", " ").slice(0, 16)} UTC` : "No webhook received yet - place a test order",
    },
    {
      key: "import",
      label: "Appstle balances imported",
      ok: importedRows > 0,
      detail: importedRows > 0 ? `${importedRows} customers imported` : "Not imported yet (run the importer on the freeze day)",
    },
  ];

  return {
    members: { total, paid, withBalance, newLast30d },
    points: {
      issued30d: sum(["earn", "signup_bonus", "adjust"]),
      redeemed30d: -sum(["redeem"]) - sum(["redeem_release"]),
      outstanding: outstandingAgg._sum.balanceCached ?? 0,
      expired30d: -sum(["expire"]),
    },
    redemptions30d: {
      storeCredit: redCount("store_credit"),
      cartDiscount: redCount("cart_discount"),
      discountCode: redCount("discount_code"),
      amountCents: red30.reduce((a, r) => a + (r._sum.amountCents ?? 0), 0),
    },
    webhooks: {
      last24h,
      failed24h,
      lastReceivedAt: lastEvent?.receivedAt.toISOString() ?? null,
      lastTopic: lastEvent?.topic ?? null,
      pendingReceived,
    },
    recentEvents: recent.map((e) => ({
      at: e.receivedAt.toISOString().replace("T", " ").slice(0, 16),
      topic: e.topic,
      status: e.status,
      note: e.error,
    })),
    checklist,
    settingsSaved: settings.persisted,
    imported: importedRows,
  };
}
