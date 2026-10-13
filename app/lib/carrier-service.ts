// Pure helpers for the live path of Hikyaku rates at checkout (HIK-206): the
// carrier service the app registers so Shopify asks hikyaku-api for rates.
// carrier-service.server.ts does the Admin API calls.

/** The carrier service's name, shown to the merchant in Shipping and delivery. */
export const CARRIER_SERVICE_NAME = "Hikyaku";

/** hikyaku-api's public endpoint Shopify calls at checkout (HIK-209). */
export const CARRIER_CALLBACK_PATH =
  "/api/v1/integrations/shopify/carrier-rates";

/** The callback URL on the given hikyaku-api base URL. */
export function carrierCallbackUrl(apiUrl: string): string {
  return new URL(CARRIER_CALLBACK_PATH, apiUrl).toString();
}

export interface CarrierServiceLike {
  id: string;
  name: string | null;
  callbackUrl: string | null;
  active: boolean;
}

function sameUrl(a: string | null, b: string): boolean {
  if (!a) return false;
  const strip = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  return strip(a) === strip(b);
}

/**
 * The app's own carrier service among the shop's: the one with the stored
 * GID, else the one calling our callback URL. Matching on the URL lets a
 * re-enable find a service whose GID was lost (a failed save, a reconnect)
 * instead of registering a second one.
 */
export function findOwnCarrierService<T extends CarrierServiceLike>(
  services: T[],
  own: { knownId: string | null; callbackUrl: string },
): T | null {
  if (own.knownId) {
    const known = services.find((service) => service.id === own.knownId);
    if (known) return known;
  }
  return (
    services.find((service) => sameUrl(service.callbackUrl, own.callbackUrl)) ??
    null
  );
}

export interface DesiredCarrierService {
  name: string;
  callbackUrl: string;
  active: boolean;
}

export type CarrierServiceStep =
  | { kind: "create"; input: DesiredCarrierService }
  | { kind: "update"; id: string; changes: Partial<DesiredCarrierService> }
  | { kind: "none"; id: string };

/**
 * What to do so the shop has exactly one Hikyaku carrier service in the
 * desired state: create it, change only the fields that differ, or nothing.
 */
export function planCarrierService(
  existing: CarrierServiceLike | null,
  desired: DesiredCarrierService,
): CarrierServiceStep {
  if (!existing) return { kind: "create", input: desired };
  const changes: Partial<DesiredCarrierService> = {};
  if (existing.name !== desired.name) changes.name = desired.name;
  if (!sameUrl(existing.callbackUrl, desired.callbackUrl)) {
    changes.callbackUrl = desired.callbackUrl;
  }
  if (existing.active !== desired.active) changes.active = desired.active;
  return Object.keys(changes).length > 0
    ? { kind: "update", id: existing.id, changes }
    : { kind: "none", id: existing.id };
}
