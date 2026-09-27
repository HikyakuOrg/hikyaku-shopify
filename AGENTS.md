# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## What this app does

`hikyaku-connect` has no Admin API usage — it makes zero `admin.graphql`/REST calls. Its only job: let a merchant connect their store to a [Hikyaku](https://hikyaku.org) account, then forward every paid order to `hikyaku-api` as a delivery job. Two credential flows exist side by side and shouldn't be confused:

- **Shopify OAuth** (`authenticate.admin` / `authenticate.webhook`, via `@shopify/shopify-app-react-router`) — the app's own install/session flow. Sessions live in the `Session` Prisma model.
- **Hikyaku OAuth** (`app/lib/hikyaku-oauth.server.ts`) — a separate PKCE flow against [Hikyaku's Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server), started from `app/routes/app._index.tsx` (opens a new tab — the consent screen at `hikyaku/app/oauth/consent` can't render inside the Shopify admin iframe) and completed at `app/routes/hikyaku.callback.tsx`. Tokens are stored as Supabase Vault secrets (`app/lib/vault.server.ts`) — `HikyakuConnection` holds only the vault secret UUIDs — in the `shopify` Postgres schema of the same Supabase project `hikyaku-api` uses.

`app/routes/webhooks.orders.paid.tsx` is the integration's core: HMAC-verified via `authenticate.webhook`, transformed by the pure function `app/lib/order-event.server.ts`, and POSTed to `hikyaku-api` by `app/lib/hikyaku-api.server.ts`. The webhook handler's response status is a deliberate retry contract with Shopify (500 = retry, 200 = don't).

Webhooks are declarative in `shopify.app.toml` (`[[webhooks.subscriptions]]`), synced via `shopify app deploy` — not registered in code.
