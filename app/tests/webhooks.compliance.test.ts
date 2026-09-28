import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: { hikyakuOAuthState: { deleteMany: vi.fn() } },
}));
vi.mock("../lib/hikyaku-api.server", () => ({ disconnect: vi.fn() }));
vi.mock("../lib/vault-session-storage.server", () => ({
  deleteShopSessions: vi.fn(),
}));

const { authenticate } = await import("../shopify.server");
const { default: prisma } = await import("../db.server");
const { disconnect } = await import("../lib/hikyaku-api.server");
const { deleteShopSessions } = await import(
  "../lib/vault-session-storage.server"
);
const { action } = await import("../routes/webhooks.compliance");

const SHOP = "example.myshopify.com";
const run = () =>
  action({ request: new Request("http://x/webhooks/compliance", { method: "POST" }) } as ActionFunctionArgs);
const asTopic = (topic: string) =>
  vi.mocked(authenticate.webhook).mockResolvedValue({ topic, shop: SHOP } as never);

describe("webhooks.compliance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shop/redact deletes sessions, the Hikyaku connection and PKCE state", async () => {
    asTopic("SHOP_REDACT");
    const res = await run();
    expect(res.status).toBe(200);
    expect(deleteShopSessions).toHaveBeenCalledWith(SHOP);
    expect(disconnect).toHaveBeenCalledWith(SHOP);
    expect(prisma.hikyakuOAuthState.deleteMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
    });
  });

  it.each(["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT"])(
    "%s stores nothing to export or erase, so it only answers 200",
    async (topic) => {
      asTopic(topic);
      const res = await run();
      expect(res.status).toBe(200);
      expect(deleteShopSessions).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid HMAC with the 401 authenticate.webhook throws", async () => {
    vi.mocked(authenticate.webhook).mockRejectedValue(
      new Response(null, { status: 401 }),
    );
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(deleteShopSessions).not.toHaveBeenCalled();
  });
});
