import { createHmac, timingSafeEqual } from "node:crypto";

// hikyaku-api's signed change push (HIK-214/HIK-216): it calls
// POST /hikyaku/resync when something behind a shop's static rates changed
// (catalog, service areas, drivers, location mappings, settings). The body is
// signed with a secret both sides share, HIKYAKU_SHOPIFY_PUSH_SECRET:
//   X-Hikyaku-Timestamp: <unix seconds>
//   X-Hikyaku-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
// A timestamp more than five minutes off is refused, so a captured push
// can't be replayed later.

export const MAX_SKEW_SECONDS = 300;

export interface HikyakuPush {
  platform: string;
  shop_domain: string;
  reasons: string[];
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function pushSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
}

export function hasValidPushSignature(params: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds: number;
}): boolean {
  const { rawBody, timestamp, signature, secret, nowSeconds } = params;
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return false;
  }
  const expected = Buffer.from(pushSignature(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Checks a push's signature and returns its body. Throws a Response: 405 for
 * a non-POST, 401 for a bad or stale signature, 400 for a body that isn't a
 * push for a Shopify shop.
 */
export async function verifyHikyakuPush(
  request: Request,
  secret = process.env.HIKYAKU_SHOPIFY_PUSH_SECRET ?? "",
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<HikyakuPush> {
  if (request.method !== "POST") {
    throw new Response(undefined, { status: 405 });
  }
  const rawBody = await request.text();
  if (
    !hasValidPushSignature({
      rawBody,
      timestamp: request.headers.get("X-Hikyaku-Timestamp"),
      signature: request.headers.get("X-Hikyaku-Signature"),
      secret,
      nowSeconds,
    })
  ) {
    throw new Response(undefined, { status: 401 });
  }
  let body: Partial<HikyakuPush>;
  try {
    body = JSON.parse(rawBody) as Partial<HikyakuPush>;
  } catch {
    throw new Response(undefined, { status: 400 });
  }
  if (
    body.platform !== "shopify" ||
    typeof body.shop_domain !== "string" ||
    !SHOP_DOMAIN.test(body.shop_domain)
  ) {
    throw new Response(undefined, { status: 400 });
  }
  return {
    platform: body.platform,
    shop_domain: body.shop_domain,
    reasons: Array.isArray(body.reasons)
      ? body.reasons.filter((r): r is string => typeof r === "string")
      : [],
  };
}
