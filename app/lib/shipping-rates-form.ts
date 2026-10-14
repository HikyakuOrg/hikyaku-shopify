// Pure helpers for the Shipping rates screen (HIK-211): how a service's price
// reads, which services can be offered, and reading the form back.

import type {
  ServiceUnit,
  ShippingRateService,
  ShippingRateSettings,
} from "./hikyaku-api.server";

const UNIT_LABEL: Record<ServiceUnit, string> = {
  per_km: "km",
  per_mi: "mi",
  per_kg: "kg",
  per_lb: "lb",
  per_delivery: "delivery",
  per_recipient: "recipient",
};

/** The unit band settings are in, or null for a flat-priced service. */
export function bandUnit(unit: ServiceUnit): "km" | "mi" | "kg" | "lb" | null {
  return unit === "per_km" ||
    unit === "per_mi" ||
    unit === "per_kg" ||
    unit === "per_lb"
    ? (UNIT_LABEL[unit] as "km" | "mi" | "kg" | "lb")
    : null;
}

export function isDistanceUnit(unit: ServiceUnit): boolean {
  return unit === "per_km" || unit === "per_mi";
}

/** "$0.50 / km", or null when the service has no price in the currency. */
export function formatRate(service: ShippingRateService): string | null {
  if (service.amount === null) return null;
  let money: string;
  try {
    money = new Intl.NumberFormat("en", {
      style: "currency",
      currency: service.currency,
    }).format(Number(service.amount));
  } catch {
    money = `${service.amount} ${service.currency}`;
  }
  return `${money} / ${UNIT_LABEL[service.unit]}`;
}

/** Field names, one per service. */
export const SERVICE_FIELD = "service";
export const bandWidthField = (serviceId: string) => `band_width:${serviceId}`;
export const bandMaxField = (serviceId: string) => `band_max:${serviceId}`;

/** Sensible starting bands for a banded service the merchant hasn't set. */
export function defaultBand(unit: ServiceUnit): {
  band_width: number;
  max: number;
} {
  switch (unit) {
    case "per_km":
      return { band_width: 5, max: 30 };
    case "per_mi":
      return { band_width: 3, max: 20 };
    case "per_kg":
      return { band_width: 5, max: 30 };
    case "per_lb":
      return { band_width: 10, max: 60 };
    default:
      return { band_width: 0, max: 0 };
  }
}

export type ParsedSettings =
  | {
      ok: true;
      enabled: boolean;
      serviceIds: string[];
      bandSettings: ShippingRateSettings["band_settings"];
    }
  | { ok: false; error: string };

/**
 * Reads the saved form: whether rates are on, the ticked services (only
 * ones the catalog has and that have a price in the shop currency) and, for
 * the banded ones, their band width and maximum. Bands are checked only when
 * `needsBands` (the static path), where hikyaku-api requires them.
 */
export function parseSettingsForm(
  form: FormData,
  services: ShippingRateService[],
  options: { needsBands: boolean },
): ParsedSettings {
  const byId = new Map(services.map((service) => [service.id, service]));
  const serviceIds = [
    ...new Set(
      form
        .getAll(SERVICE_FIELD)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  for (const id of serviceIds) {
    const service = byId.get(id);
    if (!service)
      return {
        ok: false,
        error: "A chosen service no longer exists. Reload the page.",
      };
    if (service.amount === null) {
      return {
        ok: false,
        error: `${service.name} has no price in ${service.currency}, so it can't be offered yet.`,
      };
    }
  }
  const enabled = form.get("enabled") === "on";
  if (enabled && serviceIds.length === 0) {
    return { ok: false, error: "Choose at least one service to offer." };
  }

  const bandSettings: ShippingRateSettings["band_settings"] = {};
  for (const id of serviceIds) {
    const service = byId.get(id)!;
    const unit = bandUnit(service.unit);
    if (!unit) continue;
    const width = Number(form.get(bandWidthField(id)));
    const max = Number(form.get(bandMaxField(id)));
    const valid =
      Number.isFinite(width) &&
      Number.isFinite(max) &&
      width > 0 &&
      max >= width;
    if (!valid) {
      if (!options.needsBands) continue;
      return {
        ok: false,
        error: `Set ${service.name}'s band size and maximum (in ${unit}), with the maximum at least one band.`,
      };
    }
    if (options.needsBands && max / width > 50) {
      return {
        ok: false,
        error: `${service.name} would have ${Math.ceil(max / width)} bands; use wider bands (at most 50).`,
      };
    }
    bandSettings[id] = { band_width: width, max };
  }
  return { ok: true, enabled, serviceIds, bandSettings };
}

/** A failed save as a sentence for the merchant, from hikyaku-api's 422 code. */
export function describeSettingsError(
  failure: {
    status: number | null;
    code?: string;
    serviceIds?: string[];
    detail: string;
  },
  services: ShippingRateService[],
  currency: string,
): string {
  const names = (failure.serviceIds ?? [])
    .map((id) => services.find((service) => service.id === id)?.name ?? id)
    .join(", ");
  switch (failure.code) {
    case "stripe_not_connected":
      return "Connect Stripe to your Hikyaku organisation first: rates come from its service catalog.";
    case "no_services":
      return "Your Hikyaku organisation has no services to offer yet. Add one in the Hikyaku dashboard.";
    case "service_missing_currency":
      return `${names || "A chosen service"} has no price in ${currency}. Add one in the Hikyaku dashboard.`;
    case "unknown_service":
      return `${names || "A chosen service"} is no longer in your Hikyaku catalog. Reload the page.`;
    case "band_settings_invalid":
      return `Check the band settings of ${names || "your distance and weight services"}.`;
  }
  if (failure.status === 409) {
    return "This store is connected to another Hikyaku organisation's rates. Disconnect it there first.";
  }
  if (failure.status === 403) {
    return "Your Hikyaku account isn't allowed to change shipping rates in this organisation.";
  }
  return `Couldn't save the rate settings (${failure.detail}).`;
}
