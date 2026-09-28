import prisma from "../db.server";
import {
  deleteSecret,
  readSecret,
  updateSecret,
  upsertSecret,
} from "./vault.server";
import { refreshTokens, type HikyakuTokens } from "./hikyaku-oauth.server";
import type { OrderPaidEvent } from "./order-event.server";
import type {
  HikyakuWarehouse,
  IntegrationLocation,
  IntegrationLocationInput,
} from "./location-mapping";

const REFRESH_SKEW_MS = 60_000;

function apiUrl(): string {
  const url = process.env.HIKYAKU_API_URL;
  if (!url) throw new Error("HIKYAKU_API_URL is not set");
  return url;
}

export interface HikyakuOrganisation {
  id: string;
  slug: string;
  name: string | null;
  orgType: string;
}

/**
 * Persists tokens from a freshly completed OAuth exchange, replacing any
 * prior connection for this shop — re-connecting is how a merchant changes
 * which Hikyaku account a store feeds.
 */
export async function saveConnection(
  shop: string,
  tokens: HikyakuTokens,
  user: { id: string; email: string },
): Promise<void> {
  const existing = await prisma.hikyakuConnection.findUnique({
    where: { shop },
    select: { accessTokenSecretId: true, refreshTokenSecretId: true },
  });
  const accessTokenSecretId = await upsertSecret(
    existing?.accessTokenSecretId ?? null,
    tokens.accessToken,
  );
  const refreshTokenSecretId = await upsertSecret(
    existing?.refreshTokenSecretId ?? null,
    tokens.refreshToken,
  );
  const shared = {
    hikyakuUserId: user.id,
    hikyakuEmail: user.email,
    accessTokenSecretId,
    refreshTokenSecretId,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  };
  await prisma.hikyakuConnection.upsert({
    where: { shop },
    create: { shop, ...shared },
    update: shared,
  });
}

export function getConnection(shop: string) {
  return prisma.hikyakuConnection.findUnique({ where: { shop } });
}

export async function saveOrganisation(
  shop: string,
  org: HikyakuOrganisation,
): Promise<void> {
  await prisma.hikyakuConnection.update({
    where: { shop },
    data: {
      organisationId: org.id,
      organisationSlug: org.slug,
      organisationName: org.name,
    },
  });
}

export async function disconnect(shop: string): Promise<void> {
  const existing = await prisma.hikyakuConnection.findUnique({
    where: { shop },
    select: { accessTokenSecretId: true, refreshTokenSecretId: true },
  });
  if (!existing) return;

  await prisma.hikyakuConnection.deleteMany({ where: { shop } });
  await Promise.all([
    deleteSecret(existing.accessTokenSecretId),
    deleteSecret(existing.refreshTokenSecretId),
  ]);
}

/**
 * Returns a live access token for the shop's Hikyaku connection, refreshing
 * it first if within a minute of expiry (and always persisting the rotated
 * refresh token). Returns null if the shop was never connected.
 */
export async function getValidAccessToken(
  shop: string,
): Promise<string | null> {
  const connection = await getConnection(shop);
  if (!connection) return null;

  if (connection.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
    return readSecret(connection.accessTokenSecretId);
  }

  const refreshToken = await readSecret(connection.refreshTokenSecretId);
  const refreshed = await refreshTokens(refreshToken);
  await Promise.all([
    updateSecret(connection.accessTokenSecretId, refreshed.accessToken),
    updateSecret(connection.refreshTokenSecretId, refreshed.refreshToken),
  ]);
  await prisma.hikyakuConnection.update({
    where: { shop },
    data: {
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope,
    },
  });
  return refreshed.accessToken;
}

export async function fetchOrganisations(
  accessToken: string,
): Promise<HikyakuOrganisation[]> {
  const response = await fetch(new URL("/api/v1/organisations/me", apiUrl()), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Hikyaku organisations (${response.status})`,
    );
  }
  return (await response.json()) as HikyakuOrganisation[];
}

export type OrderEventResult =
  { ok: true } | { ok: false; retry: boolean; detail: string };

/**
 * POSTs a paid-order event to Hikyaku's backend. The response mapping here
 * is the reliability contract with Shopify's webhook retrier — see
 * docs/BACKEND_HANDOFF.md:
 *   2xx / 409 (already processed) -> ok            (200 back to Shopify)
 *   4xx (bad request/auth/org)    -> retry: false   (200 back — retrying won't help)
 *   5xx / network error / timeout -> retry: true    (500 back — ask Shopify to retry)
 */
export async function postOrderEvent(
  accessToken: string,
  organisationSlug: string,
  event: OrderPaidEvent,
): Promise<OrderEventResult> {
  try {
    const response = await fetch(
      new URL("/api/v1/integrations/orders", apiUrl()),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Organisation-Slug": organisationSlug,
          "Idempotency-Key": event.event.id,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(4000),
      },
    );

    if (response.ok || response.status === 409) {
      return { ok: true };
    }
    if (response.status >= 500) {
      return { ok: false, retry: true, detail: `HTTP ${response.status}` };
    }
    return { ok: false, retry: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      retry: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The connector slug this app sends as `platform`. */
export const PLATFORM = "shopify";

/**
 * Outcome of a call to hikyaku-api. `retry` follows the same contract as
 * postOrderEvent: true for 5xx, network errors and timeouts (worth trying
 * again), false for 4xx (the request itself is wrong, or not allowed).
 */
export type HikyakuResult<T> =
  | { ok: true; data: T }
  | { ok: false; retry: boolean; status: number | null; detail: string };

const DEFAULT_TIMEOUT_MS = 10_000;

async function errorDetail(response: Response): Promise<string> {
  // NestJS errors look like { statusCode, message, error }, with `message`
  // sometimes an array of validation messages.
  try {
    const body = (await response.json()) as { message?: unknown };
    const message = Array.isArray(body.message)
      ? body.message.join("; ")
      : body.message;
    if (typeof message === "string" && message) {
      return `HTTP ${response.status}: ${message}`;
    }
  } catch {
    // Not JSON; the status alone will do.
  }
  return `HTTP ${response.status}`;
}

async function hikyakuRequest<T>(
  accessToken: string,
  organisationSlug: string,
  path: string,
  options: { method?: "GET" | "PUT"; body?: unknown; timeoutMs?: number } = {},
): Promise<HikyakuResult<T>> {
  try {
    const response = await fetch(new URL(path, apiUrl()), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Organisation-Slug": organisationSlug,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        retry: response.status >= 500,
        status: response.status,
        detail: await errorDetail(response),
      };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      retry: true,
      status: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The organisation's warehouses, ordered by name. Needs `warehouse.view`. */
export async function fetchWarehouses(
  accessToken: string,
  organisationSlug: string,
): Promise<HikyakuResult<HikyakuWarehouse[]>> {
  const result = await hikyakuRequest<{ data: HikyakuWarehouse[] }>(
    accessToken,
    organisationSlug,
    "/api/v1/warehouses",
  );
  return result.ok ? { ok: true, data: result.data.data } : result;
}

/**
 * The shop's locations as Hikyaku stores them, stale ones included (with
 * `stale_at` set). Needs `warehouse.view`.
 */
export async function fetchIntegrationLocations(
  accessToken: string,
  organisationSlug: string,
  shop: string,
): Promise<HikyakuResult<IntegrationLocation[]>> {
  const query = new URLSearchParams({ platform: PLATFORM, shop_domain: shop });
  const result = await hikyakuRequest<{ data: IntegrationLocation[] }>(
    accessToken,
    organisationSlug,
    `/api/v1/integrations/locations?${query}`,
  );
  return result.ok ? { ok: true, data: result.data.data } : result;
}

/**
 * Upserts some or all of the shop's locations and returns every location
 * Hikyaku stores for the shop afterwards. A location sent without `mode`
 * keeps its mapping (a new one starts `unmapped`). Pass `markMissingStale`
 * only when `locations` is the shop's complete list. Needs
 * `integrations.locations.write`.
 */
export async function upsertIntegrationLocations(
  accessToken: string,
  organisationSlug: string,
  shop: string,
  locations: IntegrationLocationInput[],
  options: { markMissingStale?: boolean; timeoutMs?: number } = {},
): Promise<HikyakuResult<IntegrationLocation[]>> {
  const result = await hikyakuRequest<{ data: IntegrationLocation[] }>(
    accessToken,
    organisationSlug,
    "/api/v1/integrations/locations",
    {
      method: "PUT",
      body: {
        platform: PLATFORM,
        shop_domain: shop,
        locations,
        ...(options.markMissingStale ? { mark_missing_stale: true } : {}),
      },
      timeoutMs: options.timeoutMs,
    },
  );
  return result.ok ? { ok: true, data: result.data.data } : result;
}
