import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  CARRIER_SERVICE_NAME,
  carrierCallbackUrl,
  findOwnCarrierService,
  planCarrierService,
} from "./carrier-service";
import {
  createCarrierService,
  deleteCarrierService,
  getCarrierService,
  listCarrierServices,
  updateCarrierService,
  type MutationResult,
  type ShopifyCarrierService,
} from "./shopify-admin.server";

// The live path of Hikyaku rates at checkout (HIK-206): one carrier service
// per shop, whose callback is hikyaku-api's rate endpoint. Its GID is kept in
// ShippingRates.carrierServiceId so it can be found again.

/**
 * The callback URL Shopify is given. HIKYAKU_CARRIER_CALLBACK_URL overrides
 * it for development, where HIKYAKU_API_URL is a localhost Shopify can't
 * reach.
 */
export function callbackUrl(): string {
  const override = process.env.HIKYAKU_CARRIER_CALLBACK_URL;
  if (override) return override;
  const apiUrl = process.env.HIKYAKU_API_URL;
  if (!apiUrl) throw new Error("HIKYAKU_API_URL is not set");
  return carrierCallbackUrl(apiUrl);
}

async function findOwn(
  admin: AdminApiContext,
  shop: string,
): Promise<ShopifyCarrierService | null> {
  const stored = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { carrierServiceId: true },
  });
  const knownId = stored?.carrierServiceId ?? null;
  if (knownId) {
    const known = await getCarrierService(admin, knownId);
    if (known) return known;
  }
  return findOwnCarrierService(await listCarrierServices(admin), {
    knownId,
    callbackUrl: callbackUrl(),
  });
}

async function storeId(shop: string, carrierServiceId: string | null) {
  await prisma.shippingRates.upsert({
    where: { shop },
    create: { shop, carrierServiceId },
    update: { carrierServiceId },
  });
}

/**
 * Makes sure the shop has the Hikyaku carrier service, active or not:
 * registers it the first time (or when it was deleted), otherwise reuses it
 * and changes only what differs. Shopify refuses to register it on a plan
 * without third-party carrier-calculated shipping; that comes back as
 * `ok: false` with Shopify's messages.
 */
export async function ensureCarrierService(
  admin: AdminApiContext,
  shop: string,
  options: { active: boolean },
): Promise<MutationResult<ShopifyCarrierService>> {
  const existing = await findOwn(admin, shop);
  const step = planCarrierService(existing, {
    name: CARRIER_SERVICE_NAME,
    callbackUrl: callbackUrl(),
    active: options.active,
  });

  let result: MutationResult<ShopifyCarrierService>;
  if (step.kind === "create") {
    result = await createCarrierService(admin, step.input);
  } else if (step.kind === "update") {
    result = await updateCarrierService(admin, step.id, step.changes);
  } else {
    result = { ok: true, data: existing! };
  }
  if (result.ok) await storeId(shop, result.data.id);
  return result;
}

/**
 * Deletes the shop's Hikyaku carrier service, if there is one, and forgets
 * its GID. Rates disappear from checkout at once.
 */
export async function removeCarrierService(
  admin: AdminApiContext,
  shop: string,
): Promise<MutationResult<null>> {
  const existing = await findOwn(admin, shop);
  if (existing) {
    const result = await deleteCarrierService(admin, existing.id);
    if (!result.ok) return result;
  }
  await prisma.shippingRates.updateMany({
    where: { shop },
    data: { carrierServiceId: null },
  });
  return { ok: true, data: null };
}
