import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CurrentProfile, StaticPlan } from "../lib/static-rates";
import type { ShopifyDeliveryCustomization } from "../lib/shopify-admin.server";

// syncStaticRates and removeStaticRates with Shopify, hikyaku-api and the
// database mocked: what gets written where, and that a resync with nothing
// to change makes no mutation.

vi.mock("../db.server", () => ({
  default: {
    shippingRates: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("../lib/hikyaku-api.server", () => ({
  hikyakuAccess: vi.fn(),
  fetchStaticPlan: vi.fn(),
  fetchIntegrationLocations: vi.fn(),
  describeFailure: (result: { detail: string }, doing: string) =>
    `Couldn't ${doing} (${result.detail}).`,
}));
vi.mock("../lib/shopify-admin.server", () => ({
  FUNCTION_METAFIELD_NAMESPACE: "$app:hikyaku",
  listDeliveryProfiles: vi.fn(),
  updateDeliveryProfile: vi.fn(),
  listDeliveryCustomizations: vi.fn(),
  createDeliveryCustomization: vi.fn(),
  updateDeliveryCustomization: vi.fn(),
  deleteDeliveryCustomization: vi.fn(),
}));

const { default: prisma } = await import("../db.server");
const api = await import("../lib/hikyaku-api.server");
const admin = await import("../lib/shopify-admin.server");
const { syncStaticRates, removeStaticRates } =
  await import("../lib/static-rates.server");
const { functionRates } = await import("../lib/static-rates");

const SHOP = "example.myshopify.com";
const ADMIN = {} as AdminApiContext;
const AU = "gid://shopify/Location/1";

const plan: StaticPlan = {
  currency: "AUD",
  rates: [
    {
      code: "hikyaku:flat1",
      service_id: "flat1",
      service_name: "Same Day",
      description: null,
      kind: "flat",
      price: "15.00",
      unit: null,
      band_min: null,
      band_max: null,
    },
  ],
  coverage: { v: 1, w: [{ id: "wh1", la: -37.8, ln: 144.9, e: true }] },
  bbox_fallback: false,
};

function profiles(methods: CurrentProfile["groups"][0]["zones"][0]["methods"]) {
  return [
    {
      id: "gid://shopify/DeliveryProfile/1",
      name: "General",
      groups: [
        {
          id: "group1",
          locationIds: [AU],
          zones: [
            {
              id: "zoneAU",
              name: "Domestic",
              countries: [{ code: "AU", restOfWorld: false }],
              methods,
            },
          ],
        },
      ],
    },
  ];
}

function customization(
  overrides: Partial<ShopifyDeliveryCustomization> = {},
): ShopifyDeliveryCustomization {
  return {
    id: "gid://shopify/DeliveryCustomization/9",
    title: "Hikyaku rates",
    enabled: true,
    functionId: "fn",
    coverage: { value: JSON.stringify(plan.coverage) },
    rates: { value: JSON.stringify(functionRates(plan)) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(null);
  vi.mocked(api.hikyakuAccess).mockResolvedValue({
    accessToken: "token",
    organisationSlug: "acme",
    email: "a@example.com",
  });
  vi.mocked(api.fetchStaticPlan).mockResolvedValue({ ok: true, data: plan });
  vi.mocked(api.fetchIntegrationLocations).mockResolvedValue({
    ok: true,
    data: [
      {
        id: "row1",
        platform: "shopify",
        shop_domain: SHOP,
        external_location_id: AU,
        external_location_name: "Melbourne",
        country_code: "AU",
        mode: "warehouse",
        warehouse_id: "wh1",
        stale_at: null,
        updated_at: "",
        updated_by: null,
      },
    ],
  });
  vi.mocked(admin.updateDeliveryProfile).mockResolvedValue({
    ok: true,
    data: "gid://shopify/DeliveryProfile/1",
  });
});

describe("syncStaticRates", () => {
  it("writes the rates and turns the Function on with its metafields", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(profiles([]));
    vi.mocked(admin.listDeliveryCustomizations).mockResolvedValue([]);
    vi.mocked(admin.createDeliveryCustomization).mockResolvedValue({
      ok: true,
      data: customization(),
    });

    const result = await syncStaticRates(ADMIN, SHOP);

    expect(result).toEqual({
      ok: true,
      mutations: 2,
      bboxFallback: false,
      errors: [],
    });
    expect(admin.updateDeliveryProfile).toHaveBeenCalledWith(
      ADMIN,
      "gid://shopify/DeliveryProfile/1",
      expect.objectContaining({
        locationGroupsToUpdate: [expect.objectContaining({ id: "group1" })],
      }),
    );
    expect(admin.createDeliveryCustomization).toHaveBeenCalledWith(ADMIN, {
      functionHandle: "hikyaku-delivery-rates",
      title: "Hikyaku rates",
      enabled: true,
      metafields: [
        {
          namespace: "$app:hikyaku",
          key: "coverage",
          type: "json",
          value: JSON.stringify(plan.coverage),
        },
        {
          namespace: "$app:hikyaku",
          key: "rates",
          type: "json",
          value: JSON.stringify(functionRates(plan)),
        },
      ],
    });
    expect(prisma.shippingRates.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          deliveryCustomizationId: "gid://shopify/DeliveryCustomization/9",
          staticRates: { "Hikyaku · Same Day": "hikyaku:flat1" },
          error: null,
        },
      }),
    );
  });

  it("makes no mutation when everything already matches", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(
      profiles([
        {
          id: "m1",
          name: "Hikyaku · Same Day",
          description: null,
          active: true,
          price: { amount: "15.0", currencyCode: "AUD" },
          weight: null,
        },
      ]),
    );
    vi.mocked(admin.listDeliveryCustomizations).mockResolvedValue([
      customization(),
    ]);

    const result = await syncStaticRates(ADMIN, SHOP);

    expect(result.mutations).toBe(0);
    expect(admin.updateDeliveryProfile).not.toHaveBeenCalled();
    expect(admin.createDeliveryCustomization).not.toHaveBeenCalled();
    expect(admin.updateDeliveryCustomization).not.toHaveBeenCalled();
  });

  it("updates the Function's metafields when the coverage changed", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(profiles([]));
    vi.mocked(admin.listDeliveryCustomizations).mockResolvedValue([
      customization({ coverage: { value: '{"v":1,"w":[]}' } }),
    ]);
    vi.mocked(admin.updateDeliveryCustomization).mockResolvedValue({
      ok: true,
      data: customization(),
    });

    await syncStaticRates(ADMIN, SHOP);

    expect(admin.updateDeliveryCustomization).toHaveBeenCalledWith(
      ADMIN,
      "gid://shopify/DeliveryCustomization/9",
      expect.objectContaining({ enabled: true }),
    );
  });

  it("refuses a coverage export too big for the Function", async () => {
    vi.mocked(api.fetchStaticPlan).mockResolvedValue({
      ok: true,
      data: { ...plan, coverage: { v: 1, w: "x".repeat(10_001) } },
    });

    const result = await syncStaticRates(ADMIN, SHOP);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/too large/);
    expect(admin.listDeliveryProfiles).not.toHaveBeenCalled();
    expect(prisma.shippingRates.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: { error: expect.stringMatching(/too large/) },
    });
  });

  it("records a profile Shopify refused and still reports the rest", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(profiles([]));
    vi.mocked(admin.updateDeliveryProfile).mockResolvedValue({
      ok: false,
      errors: ["Zone limit reached"],
    });
    vi.mocked(admin.listDeliveryCustomizations).mockResolvedValue([
      customization(),
    ]);

    const result = await syncStaticRates(ADMIN, SHOP);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'Couldn\'t update the "General" shipping profile: Zone limit reached',
    ]);
  });

  it("fails without a Hikyaku connection", async () => {
    vi.mocked(api.hikyakuAccess).mockResolvedValue(null);
    const result = await syncStaticRates(ADMIN, SHOP);
    expect(result.ok).toBe(false);
    expect(admin.listDeliveryProfiles).not.toHaveBeenCalled();
  });
});

describe("removeStaticRates", () => {
  it("deletes the app's rates, then the Function", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(
      profiles([
        {
          id: "m1",
          name: "Hikyaku · Same Day",
          description: null,
          active: true,
          price: { amount: "15", currencyCode: "AUD" },
          weight: null,
        },
        {
          id: "merchant",
          name: "Standard",
          description: null,
          active: true,
          price: { amount: "9", currencyCode: "AUD" },
          weight: null,
        },
      ]),
    );
    vi.mocked(admin.listDeliveryCustomizations).mockResolvedValue([
      customization(),
    ]);
    vi.mocked(admin.deleteDeliveryCustomization).mockResolvedValue({
      ok: true,
      data: "gid://shopify/DeliveryCustomization/9",
    });

    const result = await removeStaticRates(ADMIN, SHOP);

    expect(result.ok).toBe(true);
    expect(admin.updateDeliveryProfile).toHaveBeenCalledWith(
      ADMIN,
      "gid://shopify/DeliveryProfile/1",
      { methodDefinitionsToDelete: ["m1"] },
    );
    expect(admin.deleteDeliveryCustomization).toHaveBeenCalledWith(
      ADMIN,
      "gid://shopify/DeliveryCustomization/9",
    );
    expect(prisma.shippingRates.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: expect.objectContaining({
        deliveryCustomizationId: null,
        error: null,
      }),
    });
  });

  it("keeps the Function when the rates couldn't be removed", async () => {
    vi.mocked(admin.listDeliveryProfiles).mockResolvedValue(
      profiles([
        {
          id: "m1",
          name: "Hikyaku · Same Day",
          description: null,
          active: true,
          price: null,
          weight: null,
        },
      ]),
    );
    vi.mocked(admin.updateDeliveryProfile).mockResolvedValue({
      ok: false,
      errors: ["Nope"],
    });

    const result = await removeStaticRates(ADMIN, SHOP);

    expect(result.ok).toBe(false);
    expect(admin.deleteDeliveryCustomization).not.toHaveBeenCalled();
  });
});
