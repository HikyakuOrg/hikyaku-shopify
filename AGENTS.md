# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## What this app does

`hikyaku-connect` lets a merchant connect their store to a [Hikyaku](https://hikyaku.org) account, then forwards every paid order to `hikyaku-api` as a delivery job. Two credential flows exist side by side and shouldn't be confused:

- **Shopify OAuth** (`authenticate.admin` / `authenticate.webhook`, via `@shopify/shopify-app-react-router`) — the app's own install/session flow. Sessions live in the `Session` Prisma model.
- **Hikyaku OAuth** (`app/lib/hikyaku-oauth.server.ts`) — a separate PKCE flow against [Hikyaku's Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server), started from `app/routes/app._index.tsx` (opens a new tab — the consent screen at `hikyaku/app/oauth/consent` can't render inside the Shopify admin iframe) and completed at `app/routes/hikyaku.callback.tsx`. Tokens are stored as Supabase Vault secrets (`app/lib/vault.server.ts`) — `HikyakuConnection` holds only the vault secret UUIDs — in the `shopify` Postgres schema of the same Supabase project `hikyaku-api` uses.

## Screens

Embedded admin routes under `app/routes/app.*`, built with Polaris web components (`s-*`). React is 18, so prefer form submission over `onChange` on `s-*` fields, and set a boolean attribute by spreading it in only when true (`{...(x ? { selected: true } : {})}`): React 18 writes `false` as the string `"false"`.

- `app._index.tsx` (Home): connect Hikyaku, pick the organisation, then the Connected card. Picking the organisation goes straight on to Locations. While connected, a banner counts active, online fulfilling locations that are unmapped in Hikyaku (or not stored there yet): "N locations aren't mapped. Orders shipped from them will need attention in Hikyaku."
- `app.locations.tsx` (Locations, also in the app nav and linked from the Connected card): one row per location with `isActive && fulfillsOnlineOrders`, the rest (inactive, or not fulfilling online orders) in a collapsed "Other locations" section. Each row has a picker of the organisation's warehouses plus "Not delivered by Hikyaku". The form component is `app/components/location-mapping-form.tsx`.

**Suggestions** (`app/lib/location-mapping.ts`, pure and unit tested): for an unmapped active location, the nearest warehouse in the same country within 5 km (haversine) of the location's latitude/longitude is preselected and badged "Suggested". No coordinates, no country code or no warehouse in range means no suggestion. Loading the screen never saves a suggestion; pressing Save does, as it saves what the pickers show. Warehouses carry a country name ("Australia") and locations an ISO code ("AU"): names are resolved with `Intl.DisplayNames` English region names plus a short alias list (`countryCodeForName`); an unrecognised name never matches.

**Sync.** Every load of Locations re-lists the shop's locations from the Admin API and upserts them all without `mode` and with `mark_missing_stale: true`: new ones arrive `unmapped`, names and countries refresh, mappings stay, and locations gone from Shopify are marked stale in Hikyaku. Save sends only the locations whose picker changed, with an explicit `mode`. The `locations/*` webhooks upsert the one location the same way (no `mode`, no `mark_missing_stale`).

**Read-only.** The sync needs `integrations.locations.write`; reading warehouses and mappings only needs `warehouse.view`. The API can't report the caller's permissions, so the sync doubles as the check: when it returns 403, Locations reads `GET /api/v1/integrations/locations` instead and shows the same rows with the pickers and Save disabled and a "View only" banner naming the connected account. The Home banner only reads, so it works for these accounts too.

## Hikyaku API usage

All in `app/lib/hikyaku-api.server.ts`, with the shop's Hikyaku bearer token and `X-Organisation-Slug`. Location calls send `platform: "shopify"` and the shop's myshopify domain as `shop_domain`.

| Call | Function | Used by |
| --- | --- | --- |
| `GET /api/v1/organisations/me` | `fetchOrganisations` | Home, picking the organisation |
| `POST /api/v1/integrations/orders` | `postOrderEvent` | `orders/paid` webhook |
| `GET /api/v1/warehouses` | `fetchWarehouses` | Locations (pickers, suggestions) |
| `GET /api/v1/integrations/locations` | `fetchIntegrationLocations` | Home (unmapped banner) |
| `PUT /api/v1/integrations/locations` | `upsertIntegrationLocations` | Locations (sync on load, Save), `locations/*` webhooks |

## Order flow

`app/routes/webhooks.orders.paid.tsx` is the integration's core: HMAC-verified via `authenticate.webhook`, transformed by the pure function `app/lib/order-event.server.ts`, and POSTed to `hikyaku-api` by `app/lib/hikyaku-api.server.ts`. The webhook handler's response status is a deliberate retry contract with Shopify (500 = retry, 200 = don't).

**Fulfillment groups.** Before building the event, the handler reads the order's fulfillment orders (`getOrderFulfillmentOrders`, 1 s timeout: the POST gets 4 of Shopify's 5 s) and maps them with the pure `app/lib/fulfillment-groups.ts` into `fulfillment_groups`: one group per fulfillment order with its assigned location, delivery method (`SHIPPING`/`LOCAL`/`PICK_UP` become `shipping`/`local`/`pickup`, anything else `none`), the units still to fulfill (`remainingQuantity`) per line item, and a weight in grams (null if any line has no weight). A group's `line_item_id` is the numeric id taken off the `LineItem` GID, the same string as `order.line_items[].id`. An order is never sent without groups, since Hikyaku would then dispatch all of it from the nearest warehouse:

- Admin API error, timeout, or the order not found: 500 (retry).
- Routing not settled: no fulfillment orders yet, a deliverable one with no location (deleted), or an unknown status: 500 (retry).
- `OPEN`, `IN_PROGRESS` and `ON_HOLD` become groups. `CLOSED`, `CANCELLED`, `INCOMPLETE` and `SCHEDULED` (a later delivery, such as a prepaid subscription's next box) are left out; if nothing is left, the order isn't sent (200).
- Line items the payload doesn't list are left out of the groups and logged, since the API rejects the whole event otherwise.

## Admin API usage

The app makes a small, fixed set of read-only Admin GraphQL queries, all in `app/lib/shopify-admin.server.ts`. Get a client with `adminForRequest(request)` (embedded admin loaders/actions, via `authenticate.admin`) or `adminForShop(shop)` (webhook handlers and other work with no admin session, via `unauthenticated.admin` and the shop's offline session). Adding a query means adding its scope to `shopify.app.toml` and a line here.

| Query | Function | Scopes | Why |
| --- | --- | --- | --- |
| `locations` (inactive included): id, name, isActive, fulfillsOnlineOrders, address incl. countryCode/latitude/longitude | `listLocations` | `read_locations` | Multi-location stores: the merchant maps each Shopify location to a Hikyaku warehouse (Locations screen, and the Home banner's count). |
| `order.fulfillmentOrders`: id, status, assigned location, delivery method type, line items (ids, quantities, unit weight) | `getOrderFulfillmentOrders` | `read_orders`, `read_merchant_managed_fulfillment_orders` | Which location ships which line items, so a paid order is dispatched per location (`orders/paid` webhook). |
| `fulfillmentOrder.lineItems` | (internal to `getOrderFulfillmentOrders`) | `read_merchant_managed_fulfillment_orders` | Follow-up page for the rare fulfillment order with more than 40 line items. |

No REST calls and no mutations. Fulfillment order queries deliberately skip `destination`: the delivery address already arrives in `orders/paid`.

**Level 2 protected customer data.** Name/address/phone/email arrive on the `orders/paid` payload, and `read_merchant_managed_fulfillment_orders` can also read the same destination address on fulfillment orders (not queried, see above). Publishing requires Level 2 approval in the Dev Dashboard; development stores work without it.

## Webhooks

Webhooks are declarative in `shopify.app.toml` (`[[webhooks.subscriptions]]`), synced via `shopify app deploy`, not registered in code.

| Route | Topics | Status |
| --- | --- | --- |
| `webhooks.orders.paid.tsx` | `orders/paid` | Forwards the order to `hikyaku-api` with its fulfillment groups (see Order flow). |
| `webhooks.locations.tsx` | `locations/create`, `locations/update`, `locations/activate`, `locations/deactivate` | Upserts the location's name and country from the payload to `PUT /api/v1/integrations/locations` without `mode`, so a new location lands `unmapped` and an existing one keeps its mapping. Skips (200) shops not connected to Hikyaku. Same retry contract as `orders/paid`: 5xx, network error or the 4 s timeout returns 500, 4xx returns 200. A 403 (the connected account lacks `integrations.locations.write`) is logged and dropped: the Home banner still counts the location from Shopify's live list, and Locations syncs everything once the account has the permission. |
| `webhooks.fulfillment_orders.tsx` | `fulfillment_orders/moved`, `fulfillment_orders/split`, `fulfillment_orders/merged`, `fulfillment_orders/cancelled` | Verifies HMAC and logs. Will forward re-routing events to `hikyaku-api` once it can handle them. |
| `webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`, `webhooks.compliance.tsx` | App lifecycle and mandatory compliance topics | Session bookkeeping; compliance is a no-op 200. |

## Tests

`pnpm test` runs Vitest over `app/**/*.test.ts` (config in `vitest.config.ts`, kept apart from `vite.config.ts` so tests skip the React Router plugin). Tests cover pure modules such as `app/lib/location-mapping.ts` and `app/lib/fulfillment-groups.ts`. Route tests live in `app/tests/` (anything under `app/routes/` becomes a route) and mock `shopify.server`, `hikyaku-api.server` and `shopify-admin.server`; so far only `orders/paid` has one.
