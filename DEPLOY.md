# 部署 · DigitalOcean App Platform（多伦多）

老板 2026-10-28 定：应用托管搬到 DigitalOcean App Platform（tor），数据库继续 Supabase（AWS 蒙特利尔）。Fly.io 的 `fly.toml` 保留到切换完成后再删。
代码仓库：GitHub `newmarketstore-ui/Borderline-app`（2026-10-29 起）。

## 一次性准备（老板）
1. ~~GitHub 建仓库~~ 已建：`newmarketstore-ui/Borderline-app`。
2. DigitalOcean：开户绑卡 → API → 生成读写 token → 存到 `Ads automation/secrets/digitalocean.token`（不要发聊天）。
3. DigitalOcean → Apps → 授权 GitHub 组织 newmarketstore-ui（让 App Platform 能读 Borderline-app）。
4. Shopify 合作伙伴后台 → BorderlineAI → API 访问 → 申请 Protected customer data（姓名 / 邮箱 / 电话，用途：会员积分）。不批的话 `shopify app deploy` 会拒绝 orders/* 和 customers/* 的 webhook。
5. 部署后在 Shopify 后台打开应用，点一次"更新权限"（新增 customers / discounts / store credit 写权限）。
6. POS：RH、Ottawa 店员角色开"应用折扣"（折扣码兜底时用）；NMK 是 POS Lite，上不了 POS 扩展，兑分走后台应用页。

## 状态（2026-10-29 晚）
- DO 应用 `borderline-app`（tor，1× apps-s-1vcpu-2gb）已建并 ACTIVE：https://borderline-app-lntir.ondigitalocean.app（/healthz 200）。app id 存 `Ads automation/secrets/do_app_id.txt`。
- 线上库 6 个迁移已跑、pgboss schema 已建（Supabase 项目曾被暂停 → 老板 10/29 恢复并升 Pro）。
- Shopify 版本 borderlineai-10 已发布（新 scope / webhook / App Proxy / 三个扩展）。**待老板在后台打开应用点"更新权限"**，之后用测试单验收。
- 教训：Dockerfile 不能 `npm ci --omit=optional`（rollup 平台二进制也是 optional）；主题 block 的 schema 默认值不能含 `{{ }}`；customer-account 全页 target 不能与其它 target 共存一个扩展；`shopify app deploy` 非交互要 `--no-input --allow-updates`。

## 部署步骤（我来）
1. `.do/app.yaml` 里 `<GITHUB_REPO>` → `Borderline-app`；`doctl auth init --access-token-file secrets/digitalocean.token`。
2. `doctl apps create --spec .do/app.yaml`，在控制台填三项 SECRET（SHOPIFY_API_SECRET / DATABASE_URL / MANUAL_METRICS_EXPORT_TOKEN）。首次构建会跑 `prisma migrate deploy`（只加表 / 加列，不动旧数据）。
3. 拿到 `*.ondigitalocean.app` 域名后，一次性替换四处：
   - `shopify.app.toml`：`application_url`、`redirect_urls`、`[app_proxy] url`
   - `extensions/loyalty-pos/src/api.js` 和 `extensions/loyalty-account/src/api.js` 的 `APP_URL`
   - `.do/app.yaml` 的 `SHOPIFY_APP_URL`
   然后 `shopify app deploy`（同时登记 webhook、scope、App Proxy、三个扩展）。
4. 老板点"更新权限"（上面第 5 条）。
5. 验收：
   - `/healthz` 200；后台应用首页、Loyalty 三页能开；日志里 `pg-boss` 已启动。
   - 后台 Loyalty settings 保存一次（把默认规则落库）。
   - 一笔 $1 的 POS 测试单（挂一个测试客户）：10 秒内 WebhookEvent 有记录、会员页出现 earn 流水、POS 收尾屏显示"Earned N points"。
   - POS 瓷砖：给测试客户手动调 1000 分 → 一键换 $10 Store Credit → 收款页能选 Store credit。
   - 新版客户账户：登录测试客户 → Rewards 页显示余额 → 兑换一次。
   - 主题编辑器：把 Points badge 放进商品信息区、Points banner 放进购物车，开发主题预览核过再推线上。
6. 迁移 Appstle 积分（见 README「Loyalty module → Importing Appstle balances」）：冻结日当天重跑导出 → `--apply --only` 一人试点 → 全量 → 对账 → 双轨 30 天 → 卸载 Appstle。
7. 切自定义域名（可选），确认无误后停 Fly 机器。

## 服务工单模块需要的环境变量（2026-10-30）

- `KLAVIYO_PRIVATE_KEY`：Klaviyo 私钥（Settings → API keys，权限 Events: Write、Profiles: Write）。没配之前所有通知只记日志不发。**2026-10-30 已配**（本地副本在主仓库 `secrets/klaviyo_private_key.txt`，gitignored；加法 = `doctl apps spec get` → 加 SECRET 项 → `doctl apps update --spec`）。
- `SERVICE_STATUS_BASE`：客人状态页前缀，默认 `https://borderlinestore.ca/apps/loyalty-1`，不用改。
- `SERVICE_REMINDER_DAYS`：ready 几天没取发提醒，默认 3。
- 加法：DO 控制台 → App → Settings → borderline-app → Environment Variables → Add（选 Encrypt）→ Save 会自动重新部署；或改 `.do/app.yaml` 后 `doctl apps update`。

## 回滚
- DO 控制台 Deployments → 上一个成功版本 Rollback；数据库迁移只加表 / 加列，旧版本可共存。
- 扩展：`shopify app versions list` → `shopify app release --version <上一版>`。
