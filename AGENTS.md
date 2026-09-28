# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## What this app does

`hikyaku-connect` lets a merchant connect their store to a [Hikyaku](https://hikyaku.org) account, then forwards every paid order to `hikyaku-api` as a delivery job. Two credential flows exist side by side and shouldn't be confused:

- **Shopify OAuth** (`authenticate.admin` / `authenticate.webhook`, via `@shopify/shopify-app-react-router`) — the app's own install/session flow. Sessions live in the `Session` Prisma model.
- **Hikyaku OAuth** (`app/lib/hikyaku-oauth.server.ts`) — a separate PKCE flow against [Hikyaku's Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server), started from `app/routes/app._index.tsx` (opens a new tab — the consent screen at `hikyaku/app/oauth/consent` can't render inside the Shopify admin iframe) and completed at `app/routes/hikyaku.callback.tsx`. Tokens are stored as Supabase Vault secrets (`app/lib/vault.server.ts`) — `HikyakuConnection` holds only the vault secret UUIDs — in the `shopify` Postgres schema of the same Supabase project `hikyaku-api` uses.

`app/routes/webhooks.orders.paid.tsx` is the integration's core: HMAC-verified via `authenticate.webhook`, transformed by the pure function `app/lib/order-event.server.ts`, and POSTed to `hikyaku-api` by `app/lib/hikyaku-api.server.ts`. The webhook handler's response status is a deliberate retry contract with Shopify (500 = retry, 200 = don't).

## Admin API usage

The app makes a small, fixed set of read-only Admin GraphQL queries, all in `app/lib/shopify-admin.server.ts`. Get a client with `adminForRequest(request)` (embedded admin loaders/actions, via `authenticate.admin`) or `adminForShop(shop)` (webhook handlers and other work with no admin session, via `unauthenticated.admin` and the shop's offline session). Adding a query means adding its scope to `shopify.app.toml` and a line here.

| Query | Function | Scopes | Why |
| --- | --- | --- | --- |
| `locations` (inactive included): id, name, isActive, fulfillsOnlineOrders, address incl. countryCode/latitude/longitude | `listLocations` | `read_locations` | Multi-location stores: the merchant maps each Shopify location to a Hikyaku depot. |
| `order.fulfillmentOrders`: id, status, assigned location, delivery method type, line items (ids + quantities) | `getOrderFulfillmentOrders` | `read_orders`, `read_merchant_managed_fulfillment_orders` | Which location ships which line items, so a paid order is dispatched per location. |
| `fulfillmentOrder.lineItems` | (internal to `getOrderFulfillmentOrders`) | `read_merchant_managed_fulfillment_orders` | Follow-up page for the rare fulfillment order with more than 40 line items. |

No REST calls and no mutations. Fulfillment order queries deliberately skip `destination`: the delivery address already arrives in `orders/paid`.

**Level 2 protected customer data.** Name/address/phone/email arrive on the `orders/paid` payload, and `read_merchant_managed_fulfillment_orders` can also read the same destination address on fulfillment orders (not queried, see above). Publishing requires Level 2 approval in the Dev Dashboard; development stores work without it.

## Webhooks

Webhooks are declarative in `shopify.app.toml` (`[[webhooks.subscriptions]]`), synced via `shopify app deploy`, not registered in code.

| Route | Topics | Status |
| --- | --- | --- |
| `webhooks.orders.paid.tsx` | `orders/paid` | Forwards the order to `hikyaku-api`. |
| `webhooks.locations.tsx` | `locations/create`, `locations/update`, `locations/activate`, `locations/deactivate` | Verifies HMAC and logs. Will upsert the location to `hikyaku-api` (`PUT /api/v1/integrations/locations`) once that endpoint exists. |
| `webhooks.fulfillment_orders.tsx` | `fulfillment_orders/moved`, `fulfillment_orders/split`, `fulfillment_orders/merged`, `fulfillment_orders/cancelled` | Verifies HMAC and logs. Will forward re-routing events to `hikyaku-api` once it can handle them. |
| `webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`, `webhooks.compliance.tsx` | App lifecycle and mandatory compliance topics | Session bookkeeping; compliance is a no-op 200. |
