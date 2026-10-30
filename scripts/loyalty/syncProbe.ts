// 一次性探针：对一个客户跑会员同步，打印前后状态（排查 10/30 会员档被打回的问题）。只写该客户自己的行。
import prisma from "../../app/db.server";
import { applyMembership, fetchCustomerMembership } from "../../app/models/membership.server";
import { getAdminForShop } from "../../app/models/shopAdmin.server";

async function main() {
  const gid = process.argv[2];
  const shop = process.argv[3] ?? "91f13e-f1.myshopify.com";
  if (!gid) throw new Error("usage: tsx scripts/loyalty/syncProbe.ts gid://shopify/Customer/<id>");
  const before = await prisma.member.findUnique({ where: { shopifyCustomerId: gid }, include: { memberships: true } });
  console.log("before:", before?.tier, before?.paidUntil?.toISOString().slice(0, 10), before?.memberships.map((m) => `${m.source}:${m.status}:${m.endsAt?.toISOString().slice(0, 10)}`));
  const admin = await getAdminForShop(shop);
  const data = await fetchCustomerMembership(admin, gid);
  console.log("shopify tags:", data?.tags, "appstle subs:", data?.subscriptions.length);
  const after = await applyMembership(shop, data!, { memberTag: "gold-membership", createIfMember: false });
  console.log("after:", after?.tier, after?.paidUntil?.toISOString().slice(0, 10), after?.memberships.map((m) => `${m.source}:${m.status}`));
}
main().catch((e) => { console.error("ERR", e); process.exit(1); }).finally(() => prisma.$disconnect());
