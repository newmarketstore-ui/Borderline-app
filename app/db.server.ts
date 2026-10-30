import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

// Supabase session pooler 只给 15 个连接；部署切换时新旧两个容器同时在线，各自 Prisma 默认池 + pg-boss 3 个会撞上限
// （2026-10-30 服务表单首个请求 500：EMAXCONNSESSION）。没显式给 connection_limit 就压到 4，两个容器 2×(4+3)=14 < 15。
function withPoolParams(url: string | undefined): string | undefined {
  if (!url || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${process.env.PRISMA_POOL_MAX || 4}&pool_timeout=30`;
}

const makeClient = () => new PrismaClient({ datasourceUrl: withPoolParams(process.env.DATABASE_URL) });

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = makeClient();
  }
}

const prisma = global.prismaGlobal ?? makeClient();

export default prisma;
