// 应用模块开关：首页 / 导航 / 各模块路由都看这里。没有记录时用默认值。
import prisma from "../db.server";

export type ModuleKey = "loyalty" | "store_metrics" | "service_tickets" | "ai_support";

export type ModuleDef = {
  key: ModuleKey;
  name: string;
  description: string;
  defaultEnabled: boolean;
  available: boolean; // false = 还没开发，只占位
  entry: string | null; // 开着时导航去哪
};

export const MODULES: ModuleDef[] = [
  {
    key: "loyalty",
    name: "Points & membership",
    description: "Customer points, paid membership, store-credit redemption (POS tile, customer account page, storefront blocks).",
    defaultEnabled: true,
    available: true,
    entry: "/app/loyalty",
  },
  {
    key: "store_metrics",
    name: "Store daily report",
    description: "Staff enter daily walk-in groups and traffic sources per store (used for ad attribution).",
    defaultEnabled: false,
    available: true,
    entry: "/app/store-report",
  },
  {
    key: "service_tickets",
    name: "Service tickets (wax / tune)",
    description: "Customers scan the store QR and register their board (tag number); tickets per store with status, pickup date and Klaviyo notifications.",
    defaultEnabled: true,
    available: true,
    entry: "/app/services",
  },
  {
    key: "ai_support",
    name: "AI customer support",
    description: "Storefront chat answering stock, policy, order and points questions. Not built yet.",
    defaultEnabled: false,
    available: false,
    entry: null,
  },
];

export type ModuleState = ModuleDef & { enabled: boolean; updatedBy: string | null; updatedAt: string | null };

export async function getModules(shop: string): Promise<ModuleState[]> {
  const rows = await prisma.appModule.findMany({ where: { shopDomain: shop } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return MODULES.map((m) => {
    const row = byKey.get(m.key);
    return {
      ...m,
      enabled: m.available && (row ? row.enabled : m.defaultEnabled),
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}

export async function isModuleEnabled(shop: string, key: ModuleKey): Promise<boolean> {
  const mods = await getModules(shop);
  return mods.find((m) => m.key === key)?.enabled ?? false;
}

export async function setModule(shop: string, key: ModuleKey, enabled: boolean, updatedBy: string) {
  const def = MODULES.find((m) => m.key === key);
  if (!def) throw new Error(`Unknown module ${key}`);
  if (!def.available && enabled) throw new Error(`${def.name} is not built yet`);
  return prisma.appModule.upsert({
    where: { shopDomain_key: { shopDomain: shop, key } },
    create: { shopDomain: shop, key, enabled, updatedBy },
    update: { enabled, updatedBy },
  });
}

/** 模块关着时各页面统一抛这个，ErrorBoundary 会渲染成友好提示 */
export async function requireModule(shop: string, key: ModuleKey) {
  if (!(await isModuleEnabled(shop, key))) {
    const def = MODULES.find((m) => m.key === key);
    throw new Response(`${def?.name ?? key} is turned off. Enable it under Modules.`, { status: 404 });
  }
}
