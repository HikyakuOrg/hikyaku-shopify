import { createHash, randomBytes } from "node:crypto";
import prisma from "../db.server";

// Talks to Hikyaku's Supabase OAuth 2.1 server — see
// https://supabase.com/docs/guides/auth/oauth-server. This app is registered
// there as a confidential client (token_endpoint_auth_method:
// client_secret_basic); the consent screen itself already exists at
// <hikyaku web app>/oauth/consent, nothing to build on that side.
const STATE_TTL_MS = 10 * 60 * 1000; // matches Supabase's own authorization-code lifetime
const REQUESTED_SCOPE = "email profile";

function supabaseUrl(): string {
  const url = process.env.HIKYAKU_SUPABASE_URL;
  if (!url) throw new Error("HIKYAKU_SUPABASE_URL is not set");
  return url;
}

// Derived from SHOPIFY_APP_URL rather than a second env var, so the
// registered Supabase redirect URI can never silently drift from the app's
// actual URL. Must be registered byte-for-byte (no wildcards) as this
// client's redirect_uri in the Supabase dashboard.
function redirectUri(): string {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) throw new Error("SHOPIFY_APP_URL is not set");
  return new URL("/hikyaku/callback", appUrl).toString();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface HikyakuTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
}

export interface HikyakuUser {
  id: string;
  email: string;
}

/**
 * Starts a PKCE authorization attempt: persists { state, codeVerifier, shop }
 * and returns the URL to send the merchant to (in a new tab — the Supabase
 * consent screen can't render inside the Shopify admin iframe). Also sweeps
 * attempts older than the code's own lifetime, since there's no background
 * job in this MVP to do it otherwise.
 */
export async function createAuthorizationRequest(
  shop: string,
): Promise<string> {
  await prisma.hikyakuOAuthState.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - STATE_TTL_MS) } },
  });

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  await prisma.hikyakuOAuthState.create({
    data: { state, shop, codeVerifier },
  });

  const url = new URL("/auth/v1/oauth/authorize", supabaseUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", requireEnv("HIKYAKU_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", REQUESTED_SCOPE);
  return url.toString();
}

/**
 * Consumes a state row (single use) and returns the shop + code verifier it
 * belongs to, or null if it's missing, expired, or already used. The delete
 * happens before the expiry check and its count gates validity, so two
 * concurrent requests with the same state can't both succeed.
 */
export async function consumeAuthorizationState(
  state: string,
): Promise<{ shop: string; codeVerifier: string } | null> {
  const row = await prisma.hikyakuOAuthState.findUnique({ where: { state } });
  if (!row) return null;

  const { count } = await prisma.hikyakuOAuthState.deleteMany({
    where: { state },
  });
  if (count === 0) return null;
  if (row.createdAt.getTime() < Date.now() - STATE_TTL_MS) return null;

  return { shop: row.shop, codeVerifier: row.codeVerifier };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

function basicAuthHeader(): string {
  const clientId = requireEnv("HIKYAKU_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("HIKYAKU_OAUTH_CLIENT_SECRET");
  return (
    "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  );
}

async function tokenRequest(body: URLSearchParams): Promise<HikyakuTokens> {
  const response = await fetch(new URL("/auth/v1/oauth/token", supabaseUrl()), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Hikyaku token request failed (${response.status}): ${detail}`,
    );
  }

  const json = (await response.json()) as TokenResponse;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    // Supabase omits `scope` from token responses. RFC 6749 §5.1 allows that
    // when the granted scope is identical to the requested one.
    scope: json.scope ?? REQUESTED_SCOPE,
  };
}

export function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<HikyakuTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: codeVerifier,
    }),
  );
}

// Supabase rotates the refresh token on every use — callers must persist the
// new one, not just the new access token.
export function refreshTokens(refreshToken: string): Promise<HikyakuTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

// Deliberately not requesting the `openid` scope / decoding an id_token —
// that requires asymmetric JWT signing to be enabled on the Supabase
// project. A plain authenticated call to the userinfo-style endpoint avoids
// that requirement and doubles as proof the access token actually works.
export async function fetchHikyakuUser(
  accessToken: string,
): Promise<HikyakuUser> {
  const response = await fetch(new URL("/auth/v1/user", supabaseUrl()), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: requireEnv("HIKYAKU_SUPABASE_ANON_KEY"),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Hikyaku user (${response.status})`);
  }
  const json = (await response.json()) as { id: string; email: string };
  return { id: json.id, email: json.email };
}
