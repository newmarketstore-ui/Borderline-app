// 店铺离线 Admin 客户端（任务、webhook、店员页面读 Shopify 数据统一走这里）。
// shopify.server 开了 useOnlineTokens：authenticate.admin 给的是「当前员工」的在线 token，权限跟员工走；
// 店员页面只用在线 session 认人（记账写员工邮箱），读门店 / 订单、写折扣码 / metafield 一律用离线 token，
// 结果不随员工的后台权限变化。
import { sessionStorage, unauthenticated } from "../shopify.server";

export type AdminGraphql = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/** 先确认库里有离线 session，再交给库建客户端（会自动刷新过期的离线 token）。返回的 session 是离线 session。 */
export async function getOfflineAdmin(shop: string) {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (!sessions.some((s) => !s.isOnline)) {
    throw new Error(`No offline session stored for ${shop}; open the app once in Shopify admin`);
  }
  const { admin, session } = await unauthenticated.admin(shop);
  return { admin: admin as unknown as AdminGraphql, session };
}

/** 只要 GraphQL 客户端的地方（任务 / 服务层）。 */
export async function getAdminForShop(shop: string): Promise<AdminGraphql> {
  return (await getOfflineAdmin(shop)).admin;
}
