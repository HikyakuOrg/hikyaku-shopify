import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

vi.mock("../db.server", () => ({
  default: { shippingRates: { findUnique: vi.fn() } },
}));
vi.mock("../lib/hikyaku-push.server", () => ({ verifyHikyakuPush: vi.fn() }));
vi.mock("../lib/static-rates.server", () => ({ syncStaticRates: vi.fn() }));
vi.mock("../lib/shopify-admin.server", () => ({ adminForShop: vi.fn() }));

const { default: prisma } = await import("../db.server");
const { verifyHikyakuPush } = await import("../lib/hikyaku-push.server");
const { syncStaticRates } = await import("../lib/static-rates.server");
const { adminForShop } = await import("../lib/shopify-admin.server");
const { action } = await import("../routes/hikyaku.resync");

const SHOP = "example.myshopify.com";
const run = () =>
  action({
    request: new Request("https://app.example/hikyaku/resync", {
      method: "POST",
    }),
  } as ActionFunctionArgs);

function state(value: { enabled: boolean; path: string | null } | null) {
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(value as never);
}

describe("hikyaku/resync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(verifyHikyakuPush).mockResolvedValue({
      platform: "shopify",
      shop_domain: SHOP,
      reasons: ["catalog"],
    });
    vi.mocked(adminForShop).mockResolvedValue({} as never);
  });

  it("rewrites the static rates", async () => {
    state({ enabled: true, path: "static" });
    vi.mocked(syncStaticRates).mockResolvedValue({
      ok: true,
      mutations: 1,
      bboxFallback: false,
      errors: [],
    });
    expect((await run()).status).toBe(200);
    expect(syncStaticRates).toHaveBeenCalledWith(expect.anything(), SHOP);
  });

  it("asks hikyaku-api to retry when the rewrite failed", async () => {
    state({ enabled: true, path: "static" });
    vi.mocked(syncStaticRates).mockResolvedValue({
      ok: false,
      mutations: 0,
      bboxFallback: false,
      errors: ["Shopify said no"],
    });
    expect((await run()).status).toBe(500);
  });

  it.each([
    null,
    { enabled: false, path: "static" },
    { enabled: true, path: "live" },
  ])("does nothing when static rates aren't on (%o)", async (value) => {
    state(value);
    expect((await run()).status).toBe(200);
    expect(syncStaticRates).not.toHaveBeenCalled();
  });

  it("does nothing for an uninstalled shop", async () => {
    state({ enabled: true, path: "static" });
    vi.mocked(adminForShop).mockRejectedValue(new Error("No session"));
    expect((await run()).status).toBe(200);
    expect(syncStaticRates).not.toHaveBeenCalled();
  });

  it("lets a bad signature through as the 401 verifyHikyakuPush throws", async () => {
    vi.mocked(verifyHikyakuPush).mockRejectedValue(
      new Response(undefined, { status: 401 }),
    );
    await expect(run()).rejects.toMatchObject({ status: 401 });
  });
});
