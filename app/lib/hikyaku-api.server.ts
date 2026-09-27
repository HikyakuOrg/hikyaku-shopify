import prisma from "../db.server";
import {
  deleteSecret,
  readSecret,
  updateSecret,
  upsertSecret,
} from "./vault.server";
import { refreshTokens, type HikyakuTokens } from "./hikyaku-oauth.server";
import type { OrderPaidEvent } from "./order-event.server";

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
