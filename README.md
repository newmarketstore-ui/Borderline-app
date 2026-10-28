# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Loyalty module

Points ledger that replaces Appstle Loyalty (design: `reports/BorderlineAI应用_会员_打蜡服务_AI客服_架构方案_2026-10-27.md` §1, §2, §7; real Appstle rules: `reports/积分迁移_Appstle导出_2026-10-28.md` §六–§七, both in the knowledge base).

**Architecture**

```
Shopify webhook ─► app/routes/webhooks.*.tsx ─► landWebhook()            (app/models/webhookEvents.server.ts)
                     HMAC check, insert WebhookEvent, enqueue, 200 within ~3 s
pg-boss (schema pgboss, same DATABASE_URL) ─► app/jobs/worker.server.ts  (started from entry.server.tsx)
  loyalty.earn             orders/paid       → mark used redemption codes, member gate, earn ledger row
  loyalty.refund_reverse   refunds/create    → proportional refund_reverse row (balance may go negative)
  loyalty.sync_customer    customers/update  → refresh member contact + tags; queue membership sync for members / new tag
  loyalty.sync_membership  (queued)          → customer tags + appstle_membership.subscriptions → Membership rows
  loyalty.sync_balance     after any change  → customer metafield borderline.points_balance (number_integer)
  gdpr.process             customers/data_request, customers/redact, shop/redact
  loyalty.sweep            every 10 min      → requeue stuck events, mature pending points, expire / clean redemptions
Staff UI: /app/loyalty, /app/loyalty/:memberId (memberships, issue redemption, adjust, ledger),
          /app/loyalty/settings (LoyaltyConfig + redeem windows)
```

- Pure functions (unit-tested): `app/lib/loyaltyMath.ts` (earn, refund reversal), `app/lib/redeemMath.ts` (redemption quote, windows, rounding), `app/lib/membership.ts` (member check, Appstle metafield parsing, earn gate), `app/lib/appstleImport.ts` (importer mapping), `app/lib/shopifyPayload.ts` (webhook / GraphQL normalisation). Amounts are integer cents in CAD; points are floored; decimals use BigInt fixed-point.
- Services: `app/models/ledger.server.ts` (append-only ledger, member row lock, caches; Prisma only), `loyalty.server.ts` (settings, windows, Admin client), `membership.server.ts`, `redemption.server.ts`.
- Jobs and webhooks use the shop's offline session (`getAdminForShop` → `unauthenticated.admin`). Staff pages use online tokens (`useOnlineTokens: true`) so `Adjust points` / `Issue redemption` / settings record the staff email; Shopify writes from those pages (discount codes, membership refresh) still go through the offline token, so they do not depend on the staff member's admin permissions.
- `JOBS_DISABLED=1` stops this process from running workers (it can still enqueue). `PGBOSS_POOL_MAX` (default 3), `PGBOSS_SSL=require` and `PGBOSS_DATABASE_URL` are optional overrides.

**Rules (defaults = Appstle configuration read 2026-10-28; all editable in settings)**

| Setting | Default | Meaning |
|---|---|---|
| `earnRequiresMember` / `memberTag` | on / `gold-membership` | Only paying members earn. Member = customer tag, or a `Membership` with status `active` and no past `endsAt`. |
| `pointsPerDollar` | 1 | Per $1 of line subtotal; `earnOnTax` / `earnOnShipping` off. Floored. |
| `excludeDiscountedItems` | on | A line with any discount allocation (line or order-level, including our own points codes) earns nothing. |
| `excludedTags` | `Gift Card`, `Service` | Product tags that never earn (gift cards never earn regardless). |
| `redeemPointsPerDollar` | 10 | 10 points = $1 of value. |
| `redeemAmountIsTaxInclusive` / `assumedTaxRate` | on / 0.13 | Value is tax-inclusive: discount applied pre-tax = points / 10 / 1.13. |
| `redeemRounding` | `nearest_cent` | 500 pts → $44.25. `up_10_cents` reproduces Appstle's hand-typed $44.30; `floor_cent` → $44.24. |
| `minRedeemPoints` / `redeemStepPoints` | 500 / 100 | Allowed amounts: 500, 600, 700 … up to the balance. |
| `redeemRequiresMember` | on | Appstle's reward rules were restricted to `gold-membership`. |
| `redeemCodePrefix` / `redeemExpiryHours` | `POINTS` / 24 | Code format and lifetime. |
| Redeem windows (`RedeemWindow`) | Wednesday, America/Toronto, x2, POS only, members only | "Double Redeem Every Wednesday". Day 0 = Sunday; optional start / end hour (end exclusive); the biggest matching multiplier wins. Shown as the default until the settings page is saved once. |

**Memberships.** Today the source of truth is Appstle Memberships: the `gold-membership` tag plus the customer metafield `appstle_membership.subscriptions` (contract id, selling plan 8600813823, plan name, status, start / next billing). `loyalty.sync_membership` reads both via Admin GraphQL and upserts `Membership` on `(source, externalId)`; Appstle contracts that disappear from the metafield are marked `expired`. The earn job syncs on the spot when it meets a customer whose membership was never synced; customers/update queues a sync for existing members and for customers that just got the tag. Members get `tier = paid` and `paidUntil` = latest renewal date. The paid product is "Store Membership" ($50, tag `Membership`); a future `shopify_order` membership source can attach to the same table.

**Redemption flow**

1. Staff open a member, pick points (min / step respected) and channel (POS / online); the page shows the live quote (window multiplier, tax gross-up).
2. `issueRedemption()` locks the member row, re-quotes with the fresh balance, then in one transaction creates `Redemption(status issued, code, expiresAt)` and a `redeem` ledger row (−points, referenceId `redemption:<id>`). The form's idempotency key is unique on `Redemption`, so a replayed submit returns the same code.
3. `discountCodeBasicCreate`: title = code = `POINTS-<points>-<member short id>-<4 random chars>` (the random part keeps codes unique per shop), `context.customers.add = [customer]` (the non-deprecated replacement of `customerSelection`), fixed CAD amount on all items, `usageLimit 1`, `appliesOncePerCustomer`, `startsAt now`, `endsAt now + redeemExpiryHours`. On any API error the points come back with a `redeem_release` row and the redemption becomes `cancelled`.
4. The code is shown to staff. Online the customer types it at checkout; at POS (incl. NMK on POS Lite) staff attach the customer and enter the code.
5. `loyalty.earn` marks the redemption `used` when the order's `discount_codes`, `discount_applications[].code` or `discount_applications[].title` contain the code (POS orders sometimes only have the application).
6. `loyalty.sweep`: issued codes past `expiresAt` → if Shopify already counts a use, mark `used`; otherwise `discountCodeDeactivate` + `redeem_release` + `expired`. Redemptions that never got a discount id within 15 minutes (crash between steps 2 and 3) are released as `cancelled`.

**Idempotency**

1. Webhook level: `WebhookEvent.webhookId` is unique (`X-Shopify-Webhook-Id`); a retried delivery hits the unique constraint and gets a plain 200.
2. Ledger level: `PointsLedger` is append-only with `UNIQUE (type, referenceId)`: earn = order GID, refund_reverse = refund GID, staff adjust = `staff_adjust:<form key>`, redeem / redeem_release = `redemption:<id>`, migrate = `appstle:<customer id>` and `appstle:<customer id>:pending`. Postgres treats NULLs as distinct, so only rows with a referenceId are protected; every automatic row has one.
3. Each write locks the member row (`SELECT … FOR UPDATE`) inside a transaction, inserts the row and recomputes `balanceCached` / `pendingCached` from the ledger sum, so the caches can always be rebuilt from the ledger.
4. Refund reversal is cumulative: target = floor(earned × cumulative refunded eligible ÷ original eligible), minus what was already reversed.
5. Redemption status only moves forward from `issued` (`updateMany … where status = issued`); memberships upsert on `(source, externalId)`.

**Appstle importer** (`scripts/loyalty/importAppstle.ts`)

Input is the export under `backups/loyalty-migration/<timestamp>/` in the knowledge base (contains PII: never copy it into this repo).

```shell
# dry run: reads files only, never connects to a database, never prints emails
npx tsx scripts/loyalty/importAppstle.ts --rows <dir>/migrate_rows.jsonl --members <dir>/customers_bulk.jsonl
# options: --members <dir>/customers_loyalty.csv (contract details are summary-only there; prefer the bulk jsonl)
#          --only <customerId>  --include-anomalies  --all-members (also create members that have no points)
#          --pending-days N (default: LoyaltyConfig.pendingDays, else 0)
# write (DATABASE_URL must be set in the environment; .env is not read; --confirm-db must equal host:port/db)
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/loyalty_dev \
  npx tsx scripts/loyalty/importAppstle.ts --rows … --members … --apply \
  --shop <shop>.myshopify.com --confirm-db localhost:55432/loyalty_dev
```

Per customer it upserts `Member` (contact + tags from the member file, `source = appstle_migrated`), `Membership` rows from `appstle_membership.subscriptions`, a `MigrationSnapshot` (Appstle JSON + flags, no email) and up to two `migrate` ledger rows (available, floored and possibly negative; pending, `availableAt` = now + pendingDays). Rows flagged `anomaly_huge_balance` are skipped unless `--include-anomalies`. Re-running is safe. Re-export from Appstle on cut-over day before the real run.

**Tests**

```shell
npx vitest run      # or: npm test
npm run typecheck
npm run lint
npm run build
```

**Local database verification** (never against `DATABASE_URL` in `.env`: that is production)

```shell
docker run -d --name loyalty-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=loyalty_dev -p 55432:5432 postgres:16
export DATABASE_URL=postgresql://postgres:postgres@localhost:55432/loyalty_dev
npx prisma migrate deploy                                   # applies every migration in prisma/migrations
npx tsx scripts/loyalty/importAppstle.ts --rows … --members …                       # dry run
npx tsx scripts/loyalty/importAppstle.ts --rows … --members … --apply --only <id> \
  --shop smoke-test.myshopify.com --confirm-db localhost:55432/loyalty_dev
npx tsx scripts/loyalty/smokeQueue.ts    # boots pg-boss, fake orders/paid with stubbed Admin API, asserts a 120-point earn row
docker rm -f loyalty-pg
```

`smokeQueue.ts` refuses to run unless the database host is localhost.

**Applying the migrations in production**

Migrations are plain SQL under `prisma/migrations/`. `npm run setup` (`prisma generate && prisma migrate deploy`) runs on container start (`docker-start`) and applies pending migrations: `20261028120000_loyalty_foundation` (new tables) and `20261028180000_loyalty_membership_redemption` (new columns with defaults, `Membership`, `RedeemWindow`; two column defaults on `LoyaltyConfig` change for rows created later). pg-boss creates its own `pgboss` schema on first start. Never run `prisma migrate dev` / `db push` against `DATABASE_URL`: it is the production database.

**Before go-live**: run `shopify app deploy` so the scopes (`read_customers, write_customers, write_discounts, write_orders`) and webhook subscriptions take effect, then have the merchant re-authorise; set the host's `SCOPES` env var to the same list; request protected customer data access (name, email, phone) in the Partner Dashboard, otherwise Shopify rejects the orders/* and customers/* subscriptions; keep one machine always on (no suspend) so workers and the 10-minute sweep keep running. With online tokens every staff member opens the app once to get their own token; pages that read locations (home, daily entry) now run with that staff member's permissions.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data, by default using an [SQLite](https://www.sqlite.org/index.html) database.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

This use of SQLite works in production if your app runs as a single instance.
The database that works best for you depends on the data your app needs and how it is queried.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
