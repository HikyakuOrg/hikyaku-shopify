// Pure: which Hikyaku delivery options to keep, rename or hide at checkout
// (HIK-215). The static path writes every Hikyaku rate (a flat rate, distance
// bands, weight bands per service) into the shop's delivery profiles; Shopify
// filters weight bands itself, and this keeps, per delivery group, only the
// Hikyaku rates whose service covers the address, at the distance band that
// fits it. No imports, so the app's test suite can run it as it is.
//
// It fails closed: anything it can't be sure of (a missing or malformed
// metafield, no coordinates for the address, another currency) hides every
// Hikyaku option, and never touches the merchant's other rates.

/**
 * The `rates` metafield the app writes (functionRates in
 * app/lib/static-rates.ts): each Hikyaku method definition's name → its
 * service, the name to show, its kind and, for a distance band, its range in
 * km.
 */
export interface RatesConfig {
  v: 1;
  c: string;
  r: Record<
    string,
    { s: string; n: string; k: "f" | "d" | "w"; a?: number; b?: number }
  >;
}

/**
 * The `coverage` metafield (hikyaku-api's export): per mapped warehouse, its
 * coordinates, whether it delivers everywhere (a driver with no service area,
 * or matching switched off), its service areas as flat [lng, lat, …] rings,
 * and areas approximated by [minLng, minLat, maxLng, maxLat] boxes.
 */
export interface CoverageConfig {
  v: 1;
  w: Array<{
    id: string;
    la: number;
    ln: number;
    e?: boolean;
    p?: number[][];
    b?: number[][];
  }>;
}

export interface DeliveryOptionInput {
  handle: string;
  title?: string | null;
  code?: string | null;
  cost: { amount: string | number };
}

export interface DeliveryGroupInput {
  deliveryAddress?: {
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  deliveryOptions: DeliveryOptionInput[];
}

export interface FunctionInput {
  /** The checkout's (presentment) currency. */
  currency: string | null;
  presentmentCurrencyRate: string | number | null;
  groups: DeliveryGroupInput[];
  rates: unknown;
  coverage: unknown;
}

export type Operation =
  | { deliveryOptionHide: { deliveryOptionHandle: string } }
  | { deliveryOptionRename: { deliveryOptionHandle: string; title: string } };

function isRatesConfig(value: unknown): value is RatesConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<RatesConfig>;
  return (
    config.v === 1 &&
    typeof config.c === "string" &&
    !!config.r &&
    typeof config.r === "object"
  );
}

function isCoverageConfig(value: unknown): value is CoverageConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<CoverageConfig>;
  return (
    config.v === 1 &&
    Array.isArray(config.w) &&
    config.w.every(
      (warehouse) =>
        !!warehouse &&
        typeof warehouse.la === "number" &&
        typeof warehouse.ln === "number",
    )
  );
}

const EARTH_RADIUS_KM = 6371;

/** Straight-line (great circle) distance in km. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray casting over a flat [lng, lat, lng, lat, …] ring. */
export function inRing(lng: number, lat: number, ring: number[]): boolean {
  let inside = false;
  const n = Math.floor(ring.length / 2);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function inBox(lng: number, lat: number, box: number[]): boolean {
  return (
    box.length === 4 &&
    lng >= box[0] &&
    lat >= box[1] &&
    lng <= box[2] &&
    lat <= box[3]
  );
}

export function covers(
  warehouse: CoverageConfig["w"][number],
  lat: number,
  lng: number,
): boolean {
  if (warehouse.e) return true;
  return (
    (warehouse.p ?? []).some((ring) => inRing(lng, lat, ring)) ||
    (warehouse.b ?? []).some((box) => inBox(lng, lat, box))
  );
}

function nameOf(option: DeliveryOptionInput, rates: RatesConfig) {
  for (const key of [option.title, option.code]) {
    if (key && Object.prototype.hasOwnProperty.call(rates.r, key)) {
      return key;
    }
  }
  return null;
}

/** Any option that looks like ours, when the rates metafield can't be read. */
function looksHikyaku(option: DeliveryOptionInput): boolean {
  return [option.title, option.code].some(
    (value) => typeof value === "string" && value.startsWith("Hikyaku · "),
  );
}

function hideAll(input: FunctionInput, rates: RatesConfig | null): Operation[] {
  const operations: Operation[] = [];
  for (const group of input.groups) {
    for (const option of group.deliveryOptions) {
      if (rates ? nameOf(option, rates) : looksHikyaku(option)) {
        operations.push({
          deliveryOptionHide: { deliveryOptionHandle: option.handle },
        });
      }
    }
  }
  return operations;
}

/** The operations for one checkout. */
export function decide(input: FunctionInput): Operation[] {
  if (!isRatesConfig(input.rates)) return hideAll(input, null);
  const rates = input.rates;
  if (!isCoverageConfig(input.coverage)) return hideAll(input, rates);
  const coverage = input.coverage;
  // Rates are priced in the shop currency; Hikyaku doesn't let Shopify
  // convert them for shoppers paying in another.
  if (
    input.currency !== rates.c ||
    (input.presentmentCurrencyRate !== null &&
      Number(input.presentmentCurrencyRate) !== 1)
  ) {
    return hideAll(input, rates);
  }

  const operations: Operation[] = [];
  const hide = (option: DeliveryOptionInput) =>
    operations.push({
      deliveryOptionHide: { deliveryOptionHandle: option.handle },
    });

  for (const group of input.groups) {
    const ours = group.deliveryOptions
      .map((option) => ({ option, name: nameOf(option, rates) }))
      .filter(
        (entry): entry is { option: DeliveryOptionInput; name: string } =>
          entry.name !== null,
      );
    if (ours.length === 0) continue;

    const lat = group.deliveryAddress?.latitude;
    const lng = group.deliveryAddress?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") {
      ours.forEach(({ option }) => hide(option));
      continue;
    }

    // The shipping location isn't in the input, so the rates are for the
    // mapped warehouse nearest the address.
    let nearest: CoverageConfig["w"][number] | null = null;
    let distance = Infinity;
    for (const warehouse of coverage.w) {
      const d = haversineKm(warehouse.la, warehouse.ln, lat, lng);
      if (d < distance) {
        nearest = warehouse;
        distance = d;
      }
    }
    if (!nearest || !covers(nearest, lat, lng)) {
      ours.forEach(({ option }) => hide(option));
      continue;
    }

    // Per service, the one option to keep: a flat rate, a weight band
    // Shopify's conditions let through, or the distance band containing the
    // address. Bands share their edges, so the cheaper one wins there.
    const kept = new Map<string, DeliveryOptionInput>();
    for (const { option, name } of ours) {
      const rate = rates.r[name];
      const fits =
        rate.k !== "d" ||
        (typeof rate.a === "number" &&
          typeof rate.b === "number" &&
          distance >= rate.a &&
          distance <= rate.b);
      if (!fits) {
        hide(option);
        continue;
      }
      const current = kept.get(rate.s);
      if (!current) {
        kept.set(rate.s, option);
      } else if (Number(option.cost.amount) < Number(current.cost.amount)) {
        hide(current);
        kept.set(rate.s, option);
      } else {
        hide(option);
      }
    }

    for (const option of kept.values()) {
      const display = rates.r[nameOf(option, rates)!].n;
      if (option.title !== display) {
        operations.push({
          deliveryOptionRename: {
            deliveryOptionHandle: option.handle,
            title: display,
          },
        });
      }
    }
  }
  return operations;
}
