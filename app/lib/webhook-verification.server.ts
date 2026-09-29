import { createHmac, timingSafeEqual } from "node:crypto";

// Webhook verification without a session, for app/uninstalled and the
// compliance topics. With future.expiringOfflineAccessTokens,
// authenticate.webhook refreshes an expired offline token before returning,
// and for a shop that has uninstalled the app the refresh fails: the library
// throws a bare, unlogged 500 and the handler never runs
// (https://github.com/Shopify/shopify-app-js/issues/3360). Those topics
// arrive for shops that have uninstalled by definition, and need no token, so
// they only check the HMAC here.

export interface VerifiedWebhook {
  shop: string;
  /** As authenticate.webhook gives it: `app/uninstalled` → `APP_UNINSTALLED`. */
  topic: string;
  payload: unknown;
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Checks the webhook's HMAC against the app secret and returns its shop,
 * topic and payload. Throws a Response as authenticate.webhook does: 405 for
 * a non-POST, 401 for a bad HMAC, 400 for missing headers or a bad body.
 */
export async function verifyWebhook(
  request: Request,
  secret = process.env.SHOPIFY_API_SECRET ?? "",
): Promise<VerifiedWebhook> {
  if (request.method !== "POST") {
    throw new Response(undefined, { status: 405 });
  }
  const rawBody = await request.text();
  if (!secret || !hasValidHmac(rawBody, request.headers, secret)) {
    throw new Response(undefined, { status: 401 });
  }

  const shop = request.headers.get("X-Shopify-Shop-Domain");
  const topic = request.headers.get("X-Shopify-Topic");
  if (!shop || !SHOP_DOMAIN.test(shop) || !topic) {
    throw new Response(undefined, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Response(undefined, { status: 400 });
  }

  return {
    shop,
    topic: topic.toUpperCase().replace(/\//g, "_"),
    payload,
  };
}

function hasValidHmac(rawBody: string, headers: Headers, secret: string) {
  const header = headers.get("X-Shopify-Hmac-Sha256");
  if (!header) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest();
  const actual = Buffer.from(header, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
