import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";

// The Shipping rates screen's action with Shopify, hikyaku-api and the setup
// steps mocked: what gets saved to hikyaku-api, on which path, and what the
// merchant sees when it's refused.

vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../db.server", () => ({
  default: { shippingRates: { findUnique: vi.fn() } },
}));
vi.mock("../lib/hikyaku-api.server", () => ({
  hikyakuAccess: vi.fn(),
  fetchShippingRates: vi.fn(),
  fetchStaticPlan: vi.fn(),
  saveShippingRates: vi.fn(),
  describeFailure: (r: { detail: string }, doing: string) =>
    `Couldn't ${doing} (${r.detail}).`,
}));
vi.mock("../lib/shopify-admin.server", () => ({ getShopInfo: vi.fn() }));
vi.mock("../lib/rates-setup.server", () => ({
  applyRates: vi.fn(),
  reconcileRates: vi.fn(),
}));

const { authenticate } = await import("../shopify.server");
const { default: prisma } = await import("../db.server");
const api = await import("../lib/hikyaku-api.server");
const { getShopInfo } = await import("../lib/shopify-admin.server");
const { applyRates } = await import("../lib/rates-setup.server");
const { action } = await import("../routes/app.shipping-rates");

const SHOP = "example.myshopify.com";
const SETTINGS = {
  enabled: false,
  service_ids: [],
  shop_currency: "AUD",
  path: null,
  band_settings: {},
};
const SERVICES = [
  {
    id: "km",
    name: "Standard",
    description: null,
    unit: "per_km" as const,
    amount: "0.50",
    currency: "AUD",
  },
  {
    id: "flat",
    name: "Same Day",
    description: null,
    unit: "per_delivery" as const,
    amount: "15",
    currency: "AUD",
  },
];
const APPLIED = {
  ok: true,
  enabled: true,
  path: "live" as const,
  reason: "",
  errors: [],
  bboxFallback: false,
};

function onPlan(publicDisplayName: string) {
  vi.mocked(getShopInfo).mockResolvedValue({
    currencyCode: "AUD",
    plan: { publicDisplayName, partnerDevelopment: false, shopifyPlus: false },
  });
}

function submit(entries: Array<[string, string]>) {
  const body = new FormData();
  for (const [key, value] of entries) body.append(key, value);
  return action({
    request: new Request("https://app.example/app/shipping-rates", {
      method: "POST",
      body,
    }),
  } as ActionFunctionArgs);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticate.admin).mockResolvedValue({
    admin: {},
    session: { shop: SHOP },
  } as never);
  vi.mocked(api.hikyakuAccess).mockResolvedValue({
    accessToken: "t",
    organisationSlug: "acme",
    email: "a@x",
  });
  vi.mocked(api.fetchShippingRates).mockResolvedValue({
    ok: true,
    data: {
      settings: SETTINGS,
      stripe_connected: true,
      services: SERVICES,
      dashboard_service_url: null,
    },
  });
  vi.mocked(api.saveShippingRates).mockImplementation(async (...args) => ({
    ok: true,
    data: args[3],
  }));
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(null);
  vi.mocked(applyRates).mockResolvedValue(APPLIED);
});

describe("Shipping rates: save", () => {
  it("Advanced: saves the services on the live path, then sets up Shopify", async () => {
    onPlan("Advanced");
    const result = await submit([
      ["intent", "save"],
      ["enabled", "on"],
      ["service", "km"],
      ["service", "flat"],
    ]);

    expect(api.saveShippingRates).toHaveBeenCalledWith("t", "acme", SHOP, {
      enabled: true,
      service_ids: ["km", "flat"],
      band_settings: {},
      path: "live",
      shop_currency: "AUD",
    });
    expect(applyRates).toHaveBeenCalledWith({}, SHOP, { enabled: true });
    expect(result).toEqual({ saved: true, result: APPLIED });
  });

  it("Basic: needs band settings for a per-km service, and saves them", async () => {
    onPlan("Basic");
    expect(
      await submit([
        ["intent", "save"],
        ["enabled", "on"],
        ["service", "km"],
      ]),
    ).toMatchObject({ error: expect.stringMatching(/band size/) });
    expect(api.saveShippingRates).not.toHaveBeenCalled();

    await submit([
      ["intent", "save"],
      ["enabled", "on"],
      ["service", "km"],
      ["band_width:km", "5"],
      ["band_max:km", "30"],
    ]);
    expect(api.saveShippingRates).toHaveBeenCalledWith(
      "t",
      "acme",
      SHOP,
      expect.objectContaining({
        path: "static",
        band_settings: { km: { band_width: 5, max: 30 } },
      }),
    );
  });

  it("keeps the path the shop is already on", async () => {
    onPlan("Grow");
    vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue({
      path: "static",
    } as never);
    await submit([
      ["intent", "save"],
      ["enabled", "on"],
      ["service", "flat"],
    ]);
    expect(api.saveShippingRates).toHaveBeenCalledWith(
      "t",
      "acme",
      SHOP,
      expect.objectContaining({ path: "static" }),
    );
  });

  it("explains hikyaku-api's refusal and doesn't touch Shopify", async () => {
    onPlan("Advanced");
    vi.mocked(api.saveShippingRates).mockResolvedValue({
      ok: false,
      retry: false,
      status: 422,
      detail: "HTTP 422",
      code: "stripe_not_connected",
    });
    const result = await submit([
      ["intent", "save"],
      ["enabled", "on"],
      ["service", "flat"],
    ]);
    expect(result).toEqual({
      error:
        "Connect Stripe to your Hikyaku organisation first: rates come from its service catalog.",
    });
    expect(applyRates).not.toHaveBeenCalled();
  });

  it("a 403 switches the screen to view only", async () => {
    onPlan("Advanced");
    vi.mocked(api.saveShippingRates).mockResolvedValue({
      ok: false,
      retry: false,
      status: 403,
      detail: "HTTP 403",
    });
    expect(
      await submit([
        ["intent", "save"],
        ["service", "flat"],
      ]),
    ).toMatchObject({ readOnly: true });
  });
});

describe("Shipping rates: remove", () => {
  it("takes the rates out of Shopify, then turns them off in hikyaku-api", async () => {
    onPlan("Basic");
    vi.mocked(applyRates).mockResolvedValue({ ...APPLIED, enabled: false });
    const result = await submit([["intent", "remove"]]);
    expect(applyRates).toHaveBeenCalledWith({}, SHOP, { enabled: false });
    expect(api.saveShippingRates).toHaveBeenCalledWith(
      "t",
      "acme",
      SHOP,
      expect.objectContaining({ enabled: false }),
    );
    expect(result).toEqual({ removed: true, errors: [] });
  });
});
