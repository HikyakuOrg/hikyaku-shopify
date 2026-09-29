import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook } from "./webhook-verification.server";

const SECRET = "test-secret";
const BODY = JSON.stringify({ id: 1, domain: "example.myshopify.com" });

function webhook({
  body = BODY,
  hmac = createHmac("sha256", SECRET).update(body).digest("base64"),
  method = "POST",
  headers = {},
}: {
  body?: string;
  hmac?: string | null;
  method?: string;
  headers?: Record<string, string>;
} = {}) {
  return new Request("http://x/webhooks/app/uninstalled", {
    method,
    body: method === "POST" ? body : undefined,
    headers: {
      "X-Shopify-Shop-Domain": "example.myshopify.com",
      "X-Shopify-Topic": "app/uninstalled",
      ...(hmac === null ? {} : { "X-Shopify-Hmac-Sha256": hmac }),
      ...headers,
    },
  });
}

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (thrown: Response) => thrown.status,
  );

describe("verifyWebhook", () => {
  it("returns the shop, the topic as authenticate.webhook names it, and the payload", async () => {
    await expect(verifyWebhook(webhook(), SECRET)).resolves.toEqual({
      shop: "example.myshopify.com",
      topic: "APP_UNINSTALLED",
      payload: { id: 1, domain: "example.myshopify.com" },
    });
  });

  it("names compliance topics the same way", async () => {
    const result = await verifyWebhook(
      webhook({ headers: { "X-Shopify-Topic": "shop/redact" } }),
      SECRET,
    );
    expect(result.topic).toBe("SHOP_REDACT");
  });

  it.each([
    [
      "an HMAC made with another secret",
      webhook({
        hmac: createHmac("sha256", "other").update(BODY).digest("base64"),
      }),
    ],
    [
      "an HMAC of another body",
      webhook({
        hmac: createHmac("sha256", SECRET).update("{}").digest("base64"),
      }),
    ],
    ["a truncated HMAC", webhook({ hmac: "abc" })],
    ["no HMAC", webhook({ hmac: null })],
  ])("answers 401 for %s", async (_, request) => {
    expect(await status(verifyWebhook(request, SECRET))).toBe(401);
  });

  it("answers 401 when the app secret isn't configured", async () => {
    expect(await status(verifyWebhook(webhook(), ""))).toBe(401);
  });

  it("answers 405 for anything but POST", async () => {
    expect(
      await status(verifyWebhook(webhook({ method: "GET" }), SECRET)),
    ).toBe(405);
  });

  it.each([
    ["no shop", { "X-Shopify-Shop-Domain": "" }],
    [
      "a shop outside myshopify.com",
      { "X-Shopify-Shop-Domain": "evil.example.com" },
    ],
    ["no topic", { "X-Shopify-Topic": "" }],
  ])("answers 400 for %s", async (_, headers) => {
    expect(await status(verifyWebhook(webhook({ headers }), SECRET))).toBe(400);
  });

  it("answers 400 for a body that isn't JSON", async () => {
    expect(
      await status(verifyWebhook(webhook({ body: "not json" }), SECRET)),
    ).toBe(400);
  });
});
