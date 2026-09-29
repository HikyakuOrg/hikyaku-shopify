import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

vi.mock("../lib/webhook-verification.server", () => ({
  verifyWebhook: vi.fn(),
}));
vi.mock("../lib/shopify-admin.server", () => ({ isAppInstalled: vi.fn() }));
vi.mock("../lib/hikyaku-api.server", () => ({ disconnect: vi.fn() }));
vi.mock("../lib/vault-session-storage.server", () => ({
  deleteShopSessions: vi.fn(),
}));

const { verifyWebhook } = await import("../lib/webhook-verification.server");
const { isAppInstalled } = await import("../lib/shopify-admin.server");
const { disconnect } = await import("../lib/hikyaku-api.server");
const { deleteShopSessions } =
  await import("../lib/vault-session-storage.server");
const { action } = await import("../routes/webhooks.app.uninstalled");

const SHOP = "example.myshopify.com";
const run = () =>
  action({
    request: new Request("http://x/webhooks/app/uninstalled", {
      method: "POST",
    }),
  } as ActionFunctionArgs);

describe("webhooks.app.uninstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyWebhook).mockResolvedValue({
      shop: SHOP,
      topic: "APP_UNINSTALLED",
      payload: {},
    });
  });

  // The HIK-204 case: authenticate.webhook would have refreshed the expired
  // offline token, failed, and answered 500 before this ran.
  it("deletes the shop's sessions and Hikyaku connection once the app is gone", async () => {
    vi.mocked(isAppInstalled).mockResolvedValue(false);
    const res = await run();
    expect(res.status).toBe(200);
    expect(isAppInstalled).toHaveBeenCalledWith(SHOP, expect.any(AbortSignal));
    expect(deleteShopSessions).toHaveBeenCalledWith(SHOP);
    expect(disconnect).toHaveBeenCalledWith(SHOP);
  });

  it("leaves a reinstalled shop alone when a delivery arrives late", async () => {
    vi.mocked(isAppInstalled).mockResolvedValue(true);
    const res = await run();
    expect(res.status).toBe(200);
    expect(deleteShopSessions).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("rejects an invalid HMAC with the 401 verifyWebhook throws", async () => {
    vi.mocked(verifyWebhook).mockRejectedValue(
      new Response(null, { status: 401 }),
    );
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(isAppInstalled).not.toHaveBeenCalled();
    expect(deleteShopSessions).not.toHaveBeenCalled();
  });

  it("answers 500 when cleanup fails, so Shopify retries", async () => {
    vi.mocked(isAppInstalled).mockResolvedValue(false);
    vi.mocked(disconnect).mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow("db down");
  });
});
