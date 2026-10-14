import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ShopifyCarrierService } from "../lib/shopify-admin.server";

// ensureCarrierService and removeCarrierService with the Admin API and the
// database mocked: one Hikyaku carrier service per shop, reused rather than
// duplicated, and its GID remembered.

vi.mock("../db.server", () => ({
  default: {
    shippingRates: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("../lib/shopify-admin.server", () => ({
  listCarrierServices: vi.fn(),
  getCarrierService: vi.fn(),
  createCarrierService: vi.fn(),
  updateCarrierService: vi.fn(),
  deleteCarrierService: vi.fn(),
}));

const { default: prisma } = await import("../db.server");
const admin = await import("../lib/shopify-admin.server");
const { ensureCarrierService, removeCarrierService } =
  await import("../lib/carrier-service.server");

const SHOP = "example.myshopify.com";
const CALLBACK =
  "https://api.hikyaku.org/api/v1/integrations/shopify/carrier-rates";
const ADMIN = {} as AdminApiContext;

function carrier(
  id: number,
  overrides: Partial<ShopifyCarrierService> = {},
): ShopifyCarrierService {
  return {
    id: `gid://shopify/DeliveryCarrierService/${id}`,
    name: "Hikyaku",
    callbackUrl: CALLBACK,
    active: true,
    ...overrides,
  };
}

function stored(carrierServiceId: string | null) {
  vi.mocked(prisma.shippingRates.findUnique).mockResolvedValue(
    carrierServiceId === null ? null : ({ carrierServiceId } as never),
  );
}

describe("carrier service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HIKYAKU_API_URL", "https://api.hikyaku.org");
    vi.stubEnv("HIKYAKU_CARRIER_CALLBACK_URL", "");
    vi.mocked(admin.listCarrierServices).mockResolvedValue([]);
    vi.mocked(admin.getCarrierService).mockResolvedValue(null);
  });

  it("registers one, with service discovery, the first time and stores its GID", async () => {
    stored(null);
    vi.mocked(admin.createCarrierService).mockResolvedValue({
      ok: true,
      data: carrier(1),
    });

    const result = await ensureCarrierService(ADMIN, SHOP, { active: true });

    expect(result.ok).toBe(true);
    expect(admin.createCarrierService).toHaveBeenCalledWith(ADMIN, {
      name: "Hikyaku",
      callbackUrl: CALLBACK,
      active: true,
    });
    expect(prisma.shippingRates.upsert).toHaveBeenCalledWith({
      where: { shop: SHOP },
      create: { shop: SHOP, carrierServiceId: carrier(1).id },
      update: { carrierServiceId: carrier(1).id },
    });
  });

  it("reactivates the stored one instead of creating another", async () => {
    stored(carrier(1).id);
    vi.mocked(admin.getCarrierService).mockResolvedValue(
      carrier(1, { active: false }),
    );
    vi.mocked(admin.updateCarrierService).mockResolvedValue({
      ok: true,
      data: carrier(1),
    });

    await ensureCarrierService(ADMIN, SHOP, { active: true });

    expect(admin.createCarrierService).not.toHaveBeenCalled();
    expect(admin.updateCarrierService).toHaveBeenCalledWith(
      ADMIN,
      carrier(1).id,
      { active: true },
    );
  });

  it("finds a lost one by its callback URL", async () => {
    stored(null);
    vi.mocked(admin.listCarrierServices).mockResolvedValue([
      carrier(7, { name: "UPS", callbackUrl: "https://ups.example.com/" }),
      carrier(8, { active: true }),
    ]);
    vi.mocked(admin.updateCarrierService).mockResolvedValue({
      ok: true,
      data: carrier(8, { active: false }),
    });

    await ensureCarrierService(ADMIN, SHOP, { active: false });

    expect(admin.createCarrierService).not.toHaveBeenCalled();
    expect(admin.updateCarrierService).toHaveBeenCalledWith(
      ADMIN,
      carrier(8).id,
      { active: false },
    );
    expect(prisma.shippingRates.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { carrierServiceId: carrier(8).id } }),
    );
  });

  it("makes no mutation when it's already as wanted", async () => {
    stored(carrier(1).id);
    vi.mocked(admin.getCarrierService).mockResolvedValue(carrier(1));

    const result = await ensureCarrierService(ADMIN, SHOP, { active: true });

    expect(result).toEqual({ ok: true, data: carrier(1) });
    expect(admin.createCarrierService).not.toHaveBeenCalled();
    expect(admin.updateCarrierService).not.toHaveBeenCalled();
  });

  it("passes Shopify's refusal back and stores nothing", async () => {
    stored(null);
    vi.mocked(admin.createCarrierService).mockResolvedValue({
      ok: false,
      errors: ["Shipping rate provider is not available on your plan"],
    });

    const result = await ensureCarrierService(ADMIN, SHOP, { active: true });

    expect(result).toEqual({
      ok: false,
      errors: ["Shipping rate provider is not available on your plan"],
    });
    expect(prisma.shippingRates.upsert).not.toHaveBeenCalled();
  });

  it("deletes it and forgets the GID", async () => {
    stored(carrier(1).id);
    vi.mocked(admin.getCarrierService).mockResolvedValue(carrier(1));
    vi.mocked(admin.deleteCarrierService).mockResolvedValue({
      ok: true,
      data: carrier(1).id,
    });

    const result = await removeCarrierService(ADMIN, SHOP);

    expect(result.ok).toBe(true);
    expect(admin.deleteCarrierService).toHaveBeenCalledWith(
      ADMIN,
      carrier(1).id,
    );
    expect(prisma.shippingRates.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: { carrierServiceId: null },
    });
  });

  it("removing when there is none only forgets the GID", async () => {
    stored(null);
    const result = await removeCarrierService(ADMIN, SHOP);
    expect(result.ok).toBe(true);
    expect(admin.deleteCarrierService).not.toHaveBeenCalled();
  });

  it("keeps the GID when the delete fails", async () => {
    stored(carrier(1).id);
    vi.mocked(admin.getCarrierService).mockResolvedValue(carrier(1));
    vi.mocked(admin.deleteCarrierService).mockResolvedValue({
      ok: false,
      errors: ["Nope"],
    });

    const result = await removeCarrierService(ADMIN, SHOP);

    expect(result).toEqual({ ok: false, errors: ["Nope"] });
    expect(prisma.shippingRates.updateMany).not.toHaveBeenCalled();
  });

  it("uses the callback URL override in development", async () => {
    vi.stubEnv(
      "HIKYAKU_CARRIER_CALLBACK_URL",
      "https://tunnel.example.com/rates",
    );
    stored(null);
    vi.mocked(admin.createCarrierService).mockResolvedValue({
      ok: true,
      data: carrier(1),
    });

    await ensureCarrierService(ADMIN, SHOP, { active: true });

    expect(admin.createCarrierService).toHaveBeenCalledWith(
      ADMIN,
      expect.objectContaining({
        callbackUrl: "https://tunnel.example.com/rates",
      }),
    );
  });
});
