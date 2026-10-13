import { describe, expect, it } from "vitest";
import {
  hasValidPushSignature,
  pushSignature,
  verifyHikyakuPush,
} from "./hikyaku-push.server";

const SECRET = "push-secret";
const NOW = 1_800_000_000;
const BODY = JSON.stringify({
  platform: "shopify",
  shop_domain: "example.myshopify.com",
  reasons: ["service_areas"],
});

function push(
  body = BODY,
  timestamp = String(NOW),
  signature = pushSignature(SECRET, timestamp, body),
  method = "POST",
) {
  return new Request("https://app.example/hikyaku/resync", {
    method,
    headers: {
      "X-Hikyaku-Timestamp": timestamp,
      "X-Hikyaku-Signature": signature,
    },
    body: method === "POST" ? body : undefined,
  });
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (thrown) {
    return (thrown as Response).status;
  }
}

describe("hasValidPushSignature", () => {
  const valid = {
    rawBody: BODY,
    timestamp: String(NOW),
    signature: pushSignature(SECRET, String(NOW), BODY),
    secret: SECRET,
    nowSeconds: NOW,
  };

  it("accepts the body signed with the timestamp", () => {
    expect(hasValidPushSignature(valid)).toBe(true);
    expect(hasValidPushSignature({ ...valid, nowSeconds: NOW + 299 })).toBe(
      true,
    );
  });

  it("refuses a tampered body, another secret or a stale timestamp", () => {
    expect(hasValidPushSignature({ ...valid, rawBody: `${BODY} ` })).toBe(
      false,
    );
    expect(hasValidPushSignature({ ...valid, secret: "other" })).toBe(false);
    expect(hasValidPushSignature({ ...valid, nowSeconds: NOW + 301 })).toBe(
      false,
    );
    expect(hasValidPushSignature({ ...valid, secret: "" })).toBe(false);
    expect(hasValidPushSignature({ ...valid, signature: null })).toBe(false);
    expect(hasValidPushSignature({ ...valid, timestamp: "soon" })).toBe(false);
  });
});

describe("verifyHikyakuPush", () => {
  it("returns the push", async () => {
    await expect(verifyHikyakuPush(push(), SECRET, NOW)).resolves.toEqual({
      platform: "shopify",
      shop_domain: "example.myshopify.com",
      reasons: ["service_areas"],
    });
  });

  it("answers 401 for a bad signature and 405 for a GET", async () => {
    expect(
      await status(
        verifyHikyakuPush(push(BODY, String(NOW), "sha256=00"), SECRET, NOW),
      ),
    ).toBe(401);
    expect(
      await status(
        verifyHikyakuPush(
          push(BODY, String(NOW), undefined, "GET"),
          SECRET,
          NOW,
        ),
      ),
    ).toBe(405);
  });

  it("answers 400 for a signed body that isn't a Shopify push", async () => {
    const other = JSON.stringify({ platform: "woo", shop_domain: "x.com" });
    expect(await status(verifyHikyakuPush(push(other), SECRET, NOW))).toBe(400);
    expect(await status(verifyHikyakuPush(push("not json"), SECRET, NOW))).toBe(
      400,
    );
  });
});
