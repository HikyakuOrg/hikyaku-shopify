import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { removeCarrierService } from "./carrier-service.server";
import { removeStaticRates } from "./static-rates.server";

// The app's record of Hikyaku rates at checkout for a shop (the ShippingRates
// model), as the order webhooks need it.

export interface RateForwarding {
  /** Hikyaku rates are on: only orders that chose one are sent to Hikyaku. */
  enabled: boolean;
  /** Name of each Hikyaku method definition in the shop → its rate code. */
  staticRates: ReadonlyMap<string, string>;
}

/** Whether orders/paid forwards every order, or only Hikyaku-rate ones. */
export async function rateForwarding(shop: string): Promise<RateForwarding> {
  const row = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { enabled: true, staticRates: true },
  });
  const staticRates =
    row?.staticRates && typeof row.staticRates === "object"
      ? Object.entries(row.staticRates as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        )
      : [];
  return { enabled: row?.enabled ?? false, staticRates: new Map(staticRates) };
}

/**
 * Takes every Hikyaku rate out of checkout, on both paths: the carrier
 * service, and the static rates with their Function. Errors are returned, not
 * thrown, so a caller can carry on (disconnecting) and report them.
 */
export async function removeHikyakuRates(
  admin: AdminApiContext,
  shop: string,
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const carrier = await removeCarrierService(admin, shop);
    if (!carrier.ok) errors.push(...carrier.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const staticRates = await removeStaticRates(admin, shop);
    if (!staticRates.ok) errors.push(...staticRates.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}
