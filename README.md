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

Owner rules (2026-10-29): every customer with a Shopify profile earns **1 pt per $1** of line subtotal (no tax / shipping; gift cards and `Service` products excluded), **paid members earn 10 pts per $1**, and **1000 pts = $10 Shopify store credit** (works at online checkout and at POS, no code). Appstle balances import at x10 so their value is unchanged. Everything is configurable under *Loyalty → Settings*; the defaults live in `app/models/loyalty.server.ts` (`DEFAULT_SETTINGS`).

### Pieces

| Layer | Where | Notes |
|---|---|---|
| Data | `prisma/schema.prisma`: `Member`, `PointsLedger` (append-only, idempotent on `(type, referenceId)`), `Redemption`, `Membership`, `RedeemWindow`, `LoyaltyConfig`, `MigrationSnapshot`, `WebhookEvent` | Balances are cached on `Member` and recomputed from the ledger inside a row lock. |
| Earning | `webhooks.orders.paid` → `WebhookEvent` → pg-boss `loyalty.earn` (`app/jobs/loyaltyEarn.server.ts`) | Math in `app/lib/loyaltyMath.ts`. Membership is refreshed from Shopify at most every 24h; buying a product tagged `Membership` grants our own 12-month paid membership and the order earns at the paid rate. Refunds reverse proportionally (`loyalty.refund_reverse`). Optional welcome bonus. |
| Redeeming | `app/models/redemption.server.ts` | Default `store_credit`: ledger `redeem` + `storeCreditAccountCredit` (Shopify emails the customer) → status `credited`; staff can reverse (`storeCreditAccountDebit`, points returned). Fallback `discount_code` issues a single-use customer-bound code. Redeem windows (e.g. double Wednesdays at POS) multiply the value. |
| Expiry | `app/models/expiry.server.ts` (called from `loyalty.sweep`) | Off by default; `inactivity` mode zeroes balances after N months without activity. |
| Staff UI | `/app/loyalty`, `/app/loyalty/:memberId`, `/app/loyalty/settings` | Search, ledger, adjust, issue store credit / code, reverse, memberships, rules + windows editor. |
| POS | `extensions/loyalty-pos` (smart-grid tile + modal, customer-details block, post-purchase block) → `/api/pos/*` | Tile shows the cart customer's balance. Two one-tap options, each switchable in *Loyalty → Settings → POS redeem options*: **convert to store credit** (staff then takes payment with *Store credit*) or **take $X off this cart** (a fixed-amount cart discount titled with the redemption code, no typing; if no paid order uses it within the hold time the points come back via the sweep, and if POS cannot apply it the extension calls `/api/pos/release` immediately). The post-purchase block records the order at once (no waiting for the webhook). Requires POS Pro (RH, Ottawa). |
| Customer accounts | `extensions/loyalty-account` (full page `customer-account.page.render` + order-index card) → `/api/account/*` | New customer accounts only (this store uses them). |
| Storefront | `extensions/loyalty-theme` (app blocks *Points badge*, *Points banner*) → App Proxy `/apps/bl-points/{estimate,me,redeem}` | Place the blocks in the theme editor; no theme code changes. |
| Shared service | `app/models/loyaltyPublic.server.ts` | `ensureMember` (auto-enrol from Shopify), `memberSummary`, `estimatePoints`, `redeemForMember`. |

Required scopes (see `shopify.app.toml`): `read_customers, write_customers, write_discounts, write_orders, read_store_credit_accounts, write_store_credit_account_transactions` plus the original read scopes. The App Proxy in the app config is `/apps/bl-points` → `/proxy/loyalty`, but the store install got `/apps/loyalty-1` (Shopify renamed it because Appstle owns `/apps/loyalty`); the theme blocks have a `proxy_path` setting (default `/apps/loyalty-1`).

### Idempotency

Every webhook is stored once by `X-Shopify-Webhook-Id`; every ledger line carries a reference (`order gid`, `refund gid`, `redemption:<id>`, `signup:<customer>`, `appstle:<id>`), so redelivery, retries and the POS post-purchase shortcut never double count. Redemptions are keyed by a client-generated `idempotencyKey`.

### Tests and local verification

```bash
npm run typecheck && npm run lint && npx vitest run   # unit tests (math, gating, importer mapping, earn job)
npx tsx scripts/loyalty/verifyLocal.ts                 # throw-away embedded Postgres: migrations, importer dry-run/apply/idempotency, queue smoke
```

`verifyLocal` never touches `.env`; it starts `embedded-postgres` under `.local-pg/`, runs `scripts/loyalty/smokeQueue.ts` (earn 1x / 10x, refunds, store credit issue + reverse, discount-code path, Wednesday window, sweep) and deletes the data afterwards.

### Importing Appstle balances

1. On the freeze day re-run the export in the knowledge-base repo: `python scripts/loyalty_migration/export_appstle.py` → `backups/loyalty-migration/<ts>/migrate_rows.jsonl` + `customers_bulk.jsonl`.
2. Dry run: `npx tsx scripts/loyalty/importAppstle.ts --rows <migrate_rows.jsonl> --members <customers_bulk.jsonl>` (prints counts only, never emails). Points are multiplied by `LoyaltyConfig.migrationPointsMultiplier` (default 10; override with `--multiplier`).
3. Pilot: add `--apply --shop <shop>.myshopify.com --confirm-db <host:port/db> --only <customerId>` with `DATABASE_URL` set explicitly in the environment.
4. Full: same without `--only`; re-running is a no-op. The anomalous 100M-point account (an internal staff test, owner 2026-10-29) is imported with a **zero** balance (member + snapshot kept, no ledger line); pass `--include-anomalies` only if that decision changes.

Owner decisions 2026-10-29: the order that buys the membership earns at the paid rate; customers whose paid membership lapsed keep and may redeem their points but earn at the standard 1 pt per $1 (`redeemRequiresMember` off, `earnRequiresMember` off).

Production migrations are applied by `npm run setup` (`prisma migrate deploy`) at container start; all loyalty migrations only add tables / columns.

## Service tickets module

Wax / tune / binding-mount work orders for the three stores (RH, Ottawa, Newmarket). Enabled per shop under **Modules**; shows up as **Services** in the app nav.

### Flow

1. Customer scans the store QR (`/app/services/qr`) → `/apps/loyalty-1/service/<rh|ott|nmk>` (App Proxy, `proxy.loyalty.service.$store.tsx`). The form asks for the physical tag number staff handed over (RH 1–2000, Ottawa 2001–4000, NMK 4001–5000), name, email or phone, services, equipment. Edge angle only appears when an edge service is picked; height/weight (DIN optional) only for ski binding work; stance only for snowboard binding work. No waiver here (customers sign the existing waiver QR afterwards).
2. The ticket is created immediately (`createTicket`), tag reuse is blocked while another ticket on that tag is still in the store, and the customer gets a confirmation + "Service Received" Klaviyo event with a token status link (`/apps/loyalty-1/service/t/<token>`).
3. Staff work the board at `/app/services` (store switcher, Not started / In progress / On hold / Ready tabs, search by tag / name / phone / order). Buttons move status; "Done, notify" sends "Service Ready". Ticket page has "Running late?" → pick a new date, optional message → "Service Delayed" event.
4. Pickup estimate = queue ahead × tiers (`Settings`): default 0–1 ahead → today (tomorrow after 15:00), 2–10 → next day, >10 → two days; closed weekdays skipped. Customers see the concrete date on the status page, it refreshes as the queue moves.
5. Orders are linked opportunistically: an `orders/paid` at the same location within ±24 h of a ticket for the same customer marks it paid (`linkOrderToTickets`). Linking is informational; the ticket never depends on the order.
6. Pickup reminders: `loyalty.sweep` sends "Service Pickup Reminder" when a ticket has been ready for `SERVICE_REMINDER_DAYS` (default 3) days and none was sent in that window.
7. Logged-in customers also see "My ski & snowboard services" on the Rewards page (`/api/account/services`).

### Pieces

- `app/lib/serviceRules.ts` — pure rules (seed catalogue from the 2026-10 poster, field requirements, tag ranges, ETA tiers, status machine). Unit tests in `serviceRules.test.ts`.
- `app/models/services.server.ts` — Prisma access, ticket lifecycle, Klaviyo notifications (`notify`), order linking, reminders.
- `app/lib/klaviyo.server.ts` — Events API client. Without `KLAVIYO_PRIVATE_KEY` events are logged (notification rows say `log`), nothing is sent.
- `app/lib/serviceHtml.server.ts` — the mobile intake form / confirmation / status page served through the App Proxy (no theme dependency).
- Admin routes: `app.services._index.tsx`, `app.services.$ticketId.tsx`, `app.services.settings.tsx`, `app.services.qr.tsx`.
- Env: `KLAVIYO_PRIVATE_KEY`, `SERVICE_STATUS_BASE` (default `https://borderlinestore.ca/apps/loyalty-1`), `SERVICE_REMINDER_DAYS`.
- Klaviyo metrics to build flows on: `Service Received`, `Service Ready`, `Service Delayed`, `Service Pickup Reminder`, `Service Message`. Event properties: `tag_number`, `store`, `store_address`, `store_hours`, `services`, `eta_date`, `status_url`, `customer_name`, plus `new_date` / `message` on delays.

Member pricing is **not** computed here: POS sells the service listing and a native automatic discount (customer segment on the paid-member tag) applies 50 %.

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

## AI support chat module (2026-10-31)

Storefront chat answered by Claude Sonnet with read-only tools; hand-offs land in the app for staff to answer by email. Owner rules (10/31): Sonnet only, English + French, staff reply from the dashboard by email or SMS.

- **Storefront**: theme app embed `extensions/loyalty-theme/blocks/support-chat.liquid` (+ `assets/support-chat.js/.css`). Turn it on in the theme editor → App embeds → *Support chat*. On product pages it passes the handle so "is this in stock?" works without naming the product; logged-in customers are recognised through the App Proxy.
- **Endpoints** (App Proxy, Shopify-signed): `POST /apps/loyalty-1/chat` (`proxy.loyalty.chat.tsx`), `POST /apps/loyalty-1/chat/handoff`, `GET /apps/loyalty-1/chat?visitor=&conversation=` or `?token=` (resume link from the reply email).
- **Model loop**: `app/models/supportChat.server.ts` — manual tool loop, `claude-sonnet-5-5`, effort low, max 6 tool rounds, knowledge base in a 1-hour cached system block. Tools in `supportTools.server.ts`: `search_products` / `get_product` (Storefront API with `STOREFRONT_PUBLIC_TOKEN`, per-store stock from `storeAvailability`), `get_order_status` (offline Admin; guests need order number + matching email), `get_service_tickets`, `get_points_balance` (logged-in only), `request_human`.
- **Admin**: `/app/support` (conversations; default view = needs staff reply), `/app/support/<id>` (transcript with tool calls, reply by email/SMS/record-only, close, flag wrong answer), `/app/support/kb` (knowledge base docs; *Add missing defaults* seeds `supportKbSeed.ts` + stores/official policies from Shopify), `/app/support/settings` (on/off, daily USD budget, per-visitor / per-IP hourly limits, staff notification emails, greeting, extra rules).
- **Guardrails**: facts only from tools/KB (system prompt), personal data only for logged-in or order+email verified, per-visitor and per-IP hourly limits, max turns per conversation, daily budget → offline message + contact form, every reply logs tool calls and token cost (`SupportMessage.meta`, `SupportUsageDay`).
- **Notifications** (Klaviyo events → Flows, see `scripts/klaviyo_support_flows_2026_10_31.py` in the main repo): `Support Handoff` to each staff email in Settings (question, summary, transcript, admin link); `Support Reply` to the customer (reply text + link that reopens the chat).
- **Env**: `ANTHROPIC_API_KEY` (required; without it the chat only collects questions), `STOREFRONT_PUBLIC_TOKEN` (same token the winter theme uses), optional `APP_ADMIN_URL`, `STOREFRONT_BASE`, `SUPPORT_SMS_ENABLED=1` once Klaviyo SMS is live.
- Tests: `app/lib/supportRules.test.ts`. Tables: `SupportConfig`, `SupportKbDoc`, `SupportConversation`, `SupportMessage`, `SupportUsageDay` (migration `20261031120000_ai_support`).
