import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

vi.mock("../shopify.server", () => ({ authenticate: { webhook: vi.fn() } }));
vi.mock("../db.server", () => ({
  default: { shippingRates: { findUnique: vi.fn() } },
}));
vi.mock("../lib/rates-setup.server", () => ({ reconcileRates: vi.fn() }));
vi.mock("../lib/shopify-admin.server", () => ({ adminForShop: vi.fn() }));

const { authenticate } = await import("../shopify.server");
const { default: prisma } = await import("../db.server");
const { reconcileRates } = await import("../lib/rates-setup.server");
const { action } = await import("../routes/webhooks.shop.update");

const SHOP = "example.myshopify.com";
const run = (payload: unknown) => {
  vi.mocked(authenticate.webhook).mockResolvedValue({
    shop: SHOP,
    payload,
    topic: "SHOP_UPDATE",
  } as never);
  return action({
    request: new Request("https://app.example/webhooks/shop/update", {
      method: "POST",
    }),
  } as ActionFunctionArgs);
};
const state = (value: Record<string, unknown> | null) =>
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(value as never);
const ON = {
  enabled: true,
  shopPlan: "Basic",
  shopCurrency: "AUD",
  error: null,
};

describe("shop/update webhook", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(reconcileRates).mockResolvedValue({
      ok: true,
      enabled: true,
      path: "live",
      reason: null,
      errors: [],
      bboxFallback: false,
    });
  });

  it("re-checks the path when the plan changed", async () => {
    state(ON);
    const res = await run({ plan_display_name: "Advanced", currency: "AUD" });
    expect(res.status).toBe(200);
    expect(reconcileRates).toHaveBeenCalled();
  });

  it("re-checks when the currency changed", async () => {
    state(ON);
    await run({ plan_display_name: "Basic", currency: "NZD" });
    expect(reconcileRates).toHaveBeenCalled();
  });

  it("retries a setup that failed last time", async () => {
    state({ ...ON, error: "boom" });
    await run({ plan_display_name: "Basic", currency: "AUD" });
    expect(reconcileRates).toHaveBeenCalled();
  });

  it("ignores other changes, and shops with rates off", async () => {
    state(ON);
    await run({ plan_display_name: "Basic", currency: "AUD", name: "New" });
    state({ ...ON, enabled: false });
    await run({ plan_display_name: "Advanced", currency: "AUD" });
    state(null);
    await run({ plan_display_name: "Advanced", currency: "AUD" });
    expect(reconcileRates).not.toHaveBeenCalled();
  });

  it("asks Shopify to retry when the re-check threw", async () => {
    state(ON);
    vi.mocked(reconcileRates).mockRejectedValue(new Error("Throttled"));
    const res = await run({ plan_display_name: "Advanced", currency: "AUD" });
    expect(res.status).toBe(500);
  });
});
