import prisma from "../db.server";

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
    select: { enabled: true },
  });
  return { enabled: row?.enabled ?? false, staticRates: new Map() };
}
