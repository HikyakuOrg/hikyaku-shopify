import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// applyRates with every Shopify and hikyaku-api step mocked: which path a
// plan gets, the order of the steps when it switches (the old path always
// comes down before the new one goes up), and what a failed step leaves.

vi.mock("../db.server", () => ({
  default: { shippingRates: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("../lib/hikyaku-api.server", () => ({
  hikyakuAccess: vi.fn(),
  fetchShippingRates: vi.fn(),
  saveShippingRates: vi.fn(),
  describeFailure: (r: { detail: string }, doing: string) =>
    `Couldn't ${doing} (${r.detail}).`,
}));
vi.mock("../lib/carrier-service.server", () => ({
  ensureCarrierService: vi.fn(),
  removeCarrierService: vi.fn(),
}));
vi.mock("../lib/static-rates.server", () => ({
  syncStaticRates: vi.fn(),
  removeStaticRates: vi.fn(),
}));
vi.mock("../lib/shipping-rates.server", () => ({
  removeHikyakuRates: vi.fn(),
}));
vi.mock("../lib/shopify-admin.server", () => ({
  getShopInfo: vi.fn(),
  getCarrierService: vi.fn(),
}));

const { default: prisma } = await import("../db.server");
const api = await import("../lib/hikyaku-api.server");
const carrier = await import("../lib/carrier-service.server");
const staticRates = await import("../lib/static-rates.server");
const { removeHikyakuRates } = await import("../lib/shipping-rates.server");
const admin = await import("../lib/shopify-admin.server");
const { applyRates, reconcileRates } =
  await import("../lib/rates-setup.server");

const SHOP = "example.myshopify.com";
const ADMIN = {} as AdminApiContext;
const CARRIER = {
  id: "gid://shopify/DeliveryCarrierService/1",
  name: "Hikyaku",
  callbackUrl: "https://api/cb",
  active: true,
};

const steps: string[] = [];

function shopOn(plan: string) {
  vi.mocked(admin.getShopInfo).mockResolvedValue({
    currencyCode: "AUD",
    plan: {
      publicDisplayName: plan,
      partnerDevelopment: false,
      shopifyPlus: false,
    },
  });
}

function stored(state: Record<string, unknown> | null) {
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(state as never);
}

function apiSettings(path: "live" | "static" | null) {
  vi.mocked(api.fetchShippingRates).mockResolvedValue({
    ok: true,
    data: {
      settings: {
        enabled: true,
        service_ids: ["svc"],
        shop_currency: "AUD",
        path,
        band_settings: {},
      },
      stripe_connected: true,
      services: [],
      dashboard_service_url: null,
    },
  });
}

const saved = () =>
  vi.mocked(prisma.shippingRates.upsert).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.resetAllMocks();
  steps.length = 0;
  vi.mocked(api.hikyakuAccess).mockResolvedValue({
    accessToken: "t",
    organisationSlug: "acme",
    email: "a@x",
  });
  vi.mocked(api.saveShippingRates).mockImplementation(async (...args) => {
    steps.push(`api path ${args[3].path}`);
    return { ok: true, data: args[3] };
  });
  vi.mocked(carrier.ensureCarrierService).mockImplementation(
    async (_admin, _shop, { active }) => {
      steps.push(`carrier ${active ? "on" : "registered off"}`);
      return { ok: true, data: { ...CARRIER, active } };
    },
  );
  vi.mocked(carrier.removeCarrierService).mockImplementation(async () => {
    steps.push("carrier removed");
    return { ok: true, data: null };
  });
  vi.mocked(staticRates.syncStaticRates).mockImplementation(async () => {
    steps.push("static written");
    return { ok: true, mutations: 1, bboxFallback: false, errors: [] };
  });
  vi.mocked(staticRates.removeStaticRates).mockImplementation(async () => {
    steps.push("static removed");
    return { ok: true, mutations: 1, bboxFallback: false, errors: [] };
  });
});

describe("applyRates", () => {
  it("Advanced: registers the carrier service and tells hikyaku-api", async () => {
    shopOn("Advanced");
    stored(null);
    apiSettings(null);

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result).toMatchObject({ ok: true, enabled: true, path: "live" });
    expect(steps).toEqual([
      "carrier registered off",
      "carrier on",
      "api path live",
    ]);
    expect(saved()).toMatchObject({
      update: {
        enabled: true,
        path: "live",
        error: null,
        shopPlan: "Advanced",
        shopCurrency: "AUD",
      },
    });
  });

  it("Basic: removes any carrier service, then writes static rates", async () => {
    shopOn("Basic");
    stored(null);
    apiSettings(null);

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result).toMatchObject({ ok: true, path: "static" });
    expect(steps).toEqual([
      "carrier removed",
      "api path static",
      "static written",
    ]);
  });

  it("upgrade (static → live): static rates come down before the carrier service switches on", async () => {
    shopOn("Advanced");
    stored({ enabled: true, path: "static", deliveryCustomizationId: "dc" });
    apiSettings("static");

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result.path).toBe("live");
    expect(steps).toEqual([
      "carrier registered off",
      "static removed",
      "carrier on",
      "api path live",
    ]);
  });

  it("downgrade (live → static): the carrier service comes down before static rates go up", async () => {
    shopOn("Basic");
    stored({ enabled: true, path: "live", carrierServiceId: CARRIER.id });
    apiSettings("live");

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result.path).toBe("static");
    expect(steps).toEqual([
      "carrier removed",
      "api path static",
      "static written",
    ]);
  });

  it("a carrier service Shopify switched off means the plan no longer qualifies", async () => {
    shopOn("Grow");
    stored({ enabled: true, path: "live", carrierServiceId: CARRIER.id });
    vi.mocked(admin.getCarrierService).mockResolvedValue({
      ...CARRIER,
      active: false,
    });
    apiSettings("live");

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result.path).toBe("static");
    expect(result.reason).toMatch(/Shopify switched off/);
  });

  it("Grow without the add-on: Shopify refuses the carrier service, so static, without touching static rates first", async () => {
    shopOn("Grow");
    stored({ enabled: true, path: "static" });
    apiSettings("static");
    vi.mocked(carrier.ensureCarrierService).mockResolvedValue({
      ok: false,
      errors: ["Carrier calculated shipping isn't available on this plan"],
    });

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result).toMatchObject({ ok: true, path: "static" });
    expect(result.reason).toMatch(/didn't allow it/);
    expect(staticRates.removeStaticRates).not.toHaveBeenCalled();
    // Already static in hikyaku-api, so no PUT.
    expect(steps).toEqual(["carrier removed", "static written"]);
  });

  it("Grow without the add-on, as Shopify answers: registered off, refused on, so static", async () => {
    shopOn("Grow");
    stored({ enabled: true, path: "static", shopPlan: "Grow" });
    apiSettings("static");
    vi.mocked(carrier.ensureCarrierService).mockImplementation(
      async (_admin, _shop, { active }) => {
        steps.push(`carrier ${active ? "on" : "registered off"}`);
        return active
          ? {
              ok: false,
              errors: [
                "Carrier Calculated Shipping must be enabled for your store before enabling: Hikyaku",
              ],
            }
          : { ok: true, data: { ...CARRIER, active: false } };
      },
    );

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result).toMatchObject({ ok: true, path: "static" });
    expect(result.reason).toMatch(/didn't allow it/);
    expect(steps).toEqual([
      "carrier registered off",
      "static removed",
      "carrier on",
      "carrier removed",
      "static written",
    ]);
  });

  it("reconciling doesn't probe again a plan Shopify refused, so static rates stay up", async () => {
    shopOn("Grow");
    stored({ enabled: true, path: "static", shopPlan: "Grow" });
    apiSettings("static");

    const result = await reconcileRates(ADMIN, SHOP);

    expect(result).toMatchObject({ ok: true, path: "static" });
    expect(result?.reason).toMatch(/didn't allow it/);
    expect(staticRates.removeStaticRates).not.toHaveBeenCalled();
    expect(steps).toEqual(["carrier removed", "static written"]);
  });

  it("reconciling probes again once the plan changed", async () => {
    shopOn("Grow");
    stored({ enabled: true, path: "static", shopPlan: "Basic" });
    apiSettings("static");

    const result = await reconcileRates(ADMIN, SHOP);

    expect(result?.path).toBe("live");
  });

  it("Grow with the add-on: live", async () => {
    shopOn("Grow");
    stored(null);
    apiSettings(null);

    expect((await applyRates(ADMIN, SHOP, { enabled: true })).path).toBe(
      "live",
    );
  });

  it("a failed second step leaves the shop on its old path with the error, to retry", async () => {
    shopOn("Basic");
    stored({ enabled: true, path: "live", carrierServiceId: CARRIER.id });
    apiSettings("live");
    vi.mocked(staticRates.syncStaticRates).mockResolvedValue({
      ok: false,
      mutations: 0,
      bboxFallback: false,
      errors: ['Couldn\'t update the "General" shipping profile: boom'],
    });

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result.ok).toBe(false);
    expect(saved()).toMatchObject({
      update: {
        path: "static",
        error: 'Couldn\'t update the "General" shipping profile: boom',
      },
    });
  });

  it("a failed first step doesn't start the second", async () => {
    shopOn("Basic");
    stored({ enabled: true, path: "live", carrierServiceId: CARRIER.id });
    vi.mocked(carrier.removeCarrierService).mockResolvedValue({
      ok: false,
      errors: ["Throttled"],
    });

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result).toMatchObject({ ok: false, path: "live" });
    expect(staticRates.syncStaticRates).not.toHaveBeenCalled();
  });

  it("explains missing band settings when switching to static", async () => {
    shopOn("Basic");
    stored(null);
    apiSettings(null);
    vi.mocked(api.saveShippingRates).mockResolvedValue({
      ok: false,
      retry: false,
      status: 422,
      detail: "HTTP 422",
      code: "band_settings_invalid",
    });

    const result = await applyRates(ADMIN, SHOP, { enabled: true });

    expect(result.errors).toEqual([
      "This store's plan needs fixed-price rates: set the band sizes on the Shipping rates screen.",
    ]);
    expect(staticRates.syncStaticRates).not.toHaveBeenCalled();
  });

  it("off: removes both paths", async () => {
    stored({ enabled: true, path: "live" });
    vi.mocked(removeHikyakuRates).mockResolvedValue([]);

    const result = await applyRates(ADMIN, SHOP, { enabled: false });

    expect(result).toMatchObject({ ok: true, enabled: false });
    expect(removeHikyakuRates).toHaveBeenCalledWith(ADMIN, SHOP);
    expect(saved()).toMatchObject({ update: { enabled: false, error: null } });
  });
});

describe("reconcileRates", () => {
  it("does nothing for a shop with rates off", async () => {
    stored({ enabled: false });
    expect(await reconcileRates(ADMIN, SHOP)).toBeNull();
    expect(admin.getShopInfo).not.toHaveBeenCalled();
  });
});
