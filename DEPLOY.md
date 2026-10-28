# 部署 · DigitalOcean App Platform（多伦多）

老板 2026-10-28 定：应用托管搬到 DigitalOcean App Platform（tor），数据库继续 Supabase（AWS 蒙特利尔）。Fly.io 的 `fly.toml` 保留到切换完成后再删。

## 一次性准备（老板）
1. GitHub：newmarketstore-ui 下新建空私有仓库（注意不能叫 `borderline-ai`，与知识库仓库同名）。
2. DigitalOcean：开户绑卡 → API → 生成读写 token → 存到 `Ads automation/secrets/digitalocean.token`。
3. DigitalOcean → Apps → 授权 GitHub 组织 newmarketstore-ui。
4. Shopify 合作伙伴后台 → BorderlineAI → API 访问 → 申请 Protected customer data（姓名 / 邮箱 / 电话）。

## 部署步骤（我来）
1. `.do/app.yaml` 里把 `<GITHUB_REPO>` 换成真实仓库名；`doctl auth init --access-token-file secrets/digitalocean.token`。
2. `doctl apps create --spec .do/app.yaml`，在控制台填三项 SECRET（SHOPIFY_API_SECRET / DATABASE_URL / MANUAL_METRICS_EXPORT_TOKEN）。
3. 首次构建成功后拿到 `*.ondigitalocean.app` 域名 → 写回 `shopify.app.toml` 的 `application_url` 和 `redirect_urls` → `shopify app deploy`（会同时登记 webhook 与新 scope）。
4. 老板在 Shopify 后台打开应用，点一次"更新权限"。
5. 验收：`/healthz` 200；后台应用首页能开；下一笔 POS 订单 10 秒内出现在 WebhookEvent 表；日志里 pg-boss 已启动。
6. 切 DNS / 自定义域名（可选），确认无误后停 Fly 机器。

## 回滚
- DO 控制台 Deployments → 上一个成功版本 Rollback；数据库迁移只加表不改旧表，可与旧版本共存。
