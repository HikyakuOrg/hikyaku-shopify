// Pure helpers for mapping Shopify locations to Hikyaku warehouses: the
// shapes hikyaku-api uses for them, the "nearest warehouse" suggestion and the
// unmapped count behind the home screen banner. No I/O here, so it is safe to
// import from route components and easy to unit test.

/** What happens to the items a Shopify location fulfils. Mirrors hikyaku-api. */
export type LocationMappingMode = "warehouse" | "not_delivered" | "unmapped";

/** One warehouse of the organisation, as `GET /api/v1/warehouses` lists it. */
export interface HikyakuWarehouse {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postcode: string;
  /** A country name as entered in Hikyaku, e.g. "Australia", not an ISO code. */
  country: string;
  timezone: string;
  lon: number;
  lat: number;
}

/** One stored location, as `/api/v1/integrations/locations` returns it. */
export interface IntegrationLocation {
  id: string;
  platform: string;
  shop_domain: string;
  external_location_id: string;
  external_location_name: string | null;
  country_code: string | null;
  mode: LocationMappingMode;
  warehouse_id: string | null;
  stale_at: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** One location in the body of `PUT /api/v1/integrations/locations`. */
export interface IntegrationLocationInput {
  external_location_id: string;
  external_location_name?: string | null;
  country_code?: string | null;
  /** Omit to keep the stored mode and warehouse (a new location starts `unmapped`). */
  mode?: LocationMappingMode;
  warehouse_id?: string | null;
}

/** The subset of a Shopify location these helpers need. */
export interface MappableLocation {
  id: string;
  name?: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
  };
}

/** How far a warehouse may be from a location and still be suggested. */
export const SUGGESTION_RADIUS_KM = 5;

const EARTH_RADIUS_KM = 6371.0088;

/** Great circle (haversine) distance in kilometres between two points. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Country matching. Warehouses carry a free text country name ("Australia")
// while Shopify locations carry an ISO 3166-1 alpha-2 code ("AU"). Names are
// resolved to codes with the English region names from Intl.DisplayNames
// (full ICU ships with Node and every current browser), so no country table
// has to be maintained here; ALIASES covers the common spellings ICU doesn't
// use. Anything that still doesn't resolve never matches, which means no
// suggestion rather than a wrong one.

// Region codes ICU names that are not countries a warehouse can be in.
const NON_COUNTRY_REGIONS = new Set(["EU", "EZ", "QO", "UN", "XA", "XB", "ZZ"]);

const ALIASES: Record<string, string> = {
  america: "US",
  usa: "US",
  "united states of america": "US",
  uk: "GB",
  britain: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  turkey: "TR",
  "czech republic": "CZ",
  holland: "NL",
  uae: "AE",
  korea: "KR",
  "republic of korea": "KR",
  "russian federation": "RU",
  "viet nam": "VN",
  macau: "MO",
  burma: "MM",
  "ivory coast": "CI",
  swaziland: "SZ",
  macedonia: "MK",
  "east timor": "TL",
  "cabo verde": "CV",
  palestine: "PS",
  "holy see": "VA",
  vatican: "VA",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  drc: "CD",
  "republic of the congo": "CG",
};

/** Lower case, no accents or punctuation, "&" as "and", no leading "the". */
function normaliseCountryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\./g, "saint ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

let countryNameIndex: Map<string, string> | null = null;
let knownCountryCodes: Set<string> | null = null;

function buildCountryNameIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const add = (name: string, code: string) => {
    const key = normaliseCountryName(name);
    if (key && !index.has(key)) index.set(key, code);
  };

  const displayNames = new Intl.DisplayNames(["en"], {
    type: "region",
    fallback: "code",
  });
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      const name = displayNames.of(code);
      if (!name || name === code) continue;
      // Deprecated codes (BU, UK, ZR, ...) canonicalise to the current one.
      const canonical = new Intl.Locale(`und-${code}`).region ?? code;
      if (NON_COUNTRY_REGIONS.has(canonical)) continue;
      add(name, canonical);
      // "Myanmar (Burma)" -> "Myanmar", "Hong Kong SAR China" -> "Hong Kong".
      add(name.replace(/\s*\(.*\)$/, ""), canonical);
      add(name.replace(/\s+SAR China$/, ""), canonical);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) add(alias, code);
  return index;
}

/**
 * ISO 3166-1 alpha-2 code for a country name such as a warehouse's `country`
 * ("Germany" -> "DE"), or null if it isn't recognised. A two letter code is
 * accepted as is.
 */
export function countryCodeForName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  countryNameIndex ??= buildCountryNameIndex();
  const key = normaliseCountryName(name);
  const byName = countryNameIndex.get(key);
  if (byName) return byName;
  if (/^[a-z]{2}$/.test(key)) {
    const code = key.toUpperCase();
    knownCountryCodes ??= new Set(countryNameIndex.values());
    if (knownCountryCodes.has(code)) return code;
  }
  return null;
}

export interface WarehouseSuggestion {
  warehouseId: string;
  distanceKm: number;
}

/**
 * The nearest warehouse in the location's own country within
 * SUGGESTION_RADIUS_KM, or null. Null too when the location has no
 * coordinates or country code: no suggestion beats a guess.
 */
export function suggestWarehouse(
  location: MappableLocation,
  warehouses: Pick<HikyakuWarehouse, "id" | "country" | "lat" | "lon">[],
  radiusKm: number = SUGGESTION_RADIUS_KM,
): WarehouseSuggestion | null {
  const { latitude, longitude, countryCode } = location.address;
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !countryCode
  ) {
    return null;
  }
  const country = countryCode.toUpperCase();

  let best: WarehouseSuggestion | null = null;
  for (const warehouse of warehouses) {
    if (!Number.isFinite(warehouse.lat) || !Number.isFinite(warehouse.lon)) {
      continue;
    }
    if (countryCodeForName(warehouse.country) !== country) continue;
    const distance = distanceKm(
      { lat: latitude, lon: longitude },
      { lat: warehouse.lat, lon: warehouse.lon },
    );
    if (distance > radiusKm) continue;
    if (!best || distance < best.distanceKm) {
      best = { warehouseId: warehouse.id, distanceKm: distance };
    }
  }
  return best;
}

/**
 * A location as the sync sends it: name and country only, no `mode`, so
 * whatever the merchant chose for it stays as it is.
 */
export function syncInput(
  location: MappableLocation,
): IntegrationLocationInput {
  return {
    external_location_id: location.id,
    external_location_name: location.name ?? null,
    country_code: location.address.countryCode
      ? location.address.countryCode.toUpperCase()
      : null,
  };
}

/** Locations the merchant has to decide on: active and fulfilling online orders. */
export function needsMapping(location: MappableLocation): boolean {
  return location.isActive && location.fulfillsOnlineOrders;
}

/**
 * How many locations that need mapping are still unmapped in Hikyaku,
 * counting a location Hikyaku hasn't stored yet as unmapped.
 */
export function countUnmapped(
  locations: MappableLocation[],
  stored: Pick<IntegrationLocation, "external_location_id" | "mode">[],
): number {
  const modes = new Map(
    stored.map((row) => [row.external_location_id, row.mode] as const),
  );
  return locations.filter(
    (location) =>
      needsMapping(location) &&
      (modes.get(location.id) ?? "unmapped") === "unmapped",
  ).length;
}

// A picker value encodes a mode and, for "warehouse", its id, so one select
// can carry both. Never "": an s-option with an empty value submits its label.
export const UNMAPPED_VALUE = "unmapped";
export const NOT_DELIVERED_VALUE = "not_delivered";
const WAREHOUSE_PREFIX = "warehouse:";

export function mappingValue(
  mode: LocationMappingMode,
  warehouseId: string | null,
): string {
  if (mode === "warehouse" && warehouseId)
    return WAREHOUSE_PREFIX + warehouseId;
  if (mode === "not_delivered") return NOT_DELIVERED_VALUE;
  return UNMAPPED_VALUE;
}

export function warehouseValue(warehouseId: string): string {
  return WAREHOUSE_PREFIX + warehouseId;
}

/** Inverse of mappingValue; null for anything it didn't produce. */
export function parseMappingValue(
  value: string,
): { mode: LocationMappingMode; warehouseId: string | null } | null {
  if (value === UNMAPPED_VALUE) return { mode: "unmapped", warehouseId: null };
  if (value === NOT_DELIVERED_VALUE) {
    return { mode: "not_delivered", warehouseId: null };
  }
  if (value.startsWith(WAREHOUSE_PREFIX)) {
    const warehouseId = value.slice(WAREHOUSE_PREFIX.length);
    if (warehouseId) return { mode: "warehouse", warehouseId };
  }
  return null;
}
