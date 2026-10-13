// Pure: the static path of Hikyaku rates at checkout (HIK-216), for shops
// whose plan can't use a carrier service. hikyaku-api computes a plan of
// rates (a flat rate, distance bands or weight bands per service); the app
// writes each as a method definition into the shop's delivery profiles, and
// the delivery customization Function (extensions/hikyaku-delivery-rates)
// keeps the one that fits the address and hides the rest.
//
// The app owns every method definition and zone whose name starts with
// STATIC_NAME_PREFIX: a resync rewrites them to match the plan (undoing hand
// edits, restoring deleted ones) and never touches anything else.

/** One rate of `GET /api/v1/integrations/shipping-rates/static-plan`. */
export interface StaticPlanRate {
  /** `hikyaku:<service_id>`, `…:d:<min>-<max>` or `…:w:<min_grams>-<max_grams>`. */
  code: string;
  service_id: string;
  service_name: string;
  description: string | null;
  kind: "flat" | "distance" | "weight";
  /** Decimal, in the plan's currency (the shop currency). */
  price: string;
  /** The service's own unit, for labels. Null for a flat rate. */
  unit?: "km" | "mi" | "kg" | "lb" | null;
  /** The band's edges in `unit`. */
  band_min?: number | null;
  band_max?: number | null;
  min_km?: number | null;
  max_km?: number | null;
  min_grams?: number | null;
  max_grams?: number | null;
}

export interface StaticPlan {
  currency: string;
  rates: StaticPlanRate[];
  /** The Function's coverage metafield, written as is. */
  coverage: unknown;
  /** Some service area was replaced by its bounding box to fit. */
  bbox_fallback: boolean;
}

export const STATIC_NAME_PREFIX = "Hikyaku · ";

export function isOwnName(name: string): boolean {
  return name.startsWith(STATIC_NAME_PREFIX);
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function bandLabel(rate: StaticPlanRate): string | null {
  if (rate.kind === "flat") return null;
  if (
    rate.unit &&
    typeof rate.band_min === "number" &&
    typeof rate.band_max === "number"
  ) {
    return `${formatNumber(rate.band_min)}–${formatNumber(rate.band_max)} ${rate.unit}`;
  }
  if (rate.kind === "distance") {
    return `${formatNumber(rate.min_km ?? 0)}–${formatNumber(rate.max_km ?? 0)} km`;
  }
  return `${formatNumber((rate.min_grams ?? 0) / 1000)}–${formatNumber((rate.max_grams ?? 0) / 1000)} kg`;
}

/** The method definition name a rate is written under, unique per rate. */
export function methodName(rate: StaticPlanRate): string {
  const label = bandLabel(rate);
  return `${STATIC_NAME_PREFIX}${rate.service_name}${label ? ` · ${label}` : ""}`;
}

/** A method definition as the app wants it in every zone it writes to. */
export interface DesiredMethod {
  name: string;
  description: string | null;
  /** Decimal string, normalised (see sameAmount). */
  price: string;
  currency: string;
  /** Grams, inclusive. Null when the rate has no weight condition. */
  weight: { min: number; max: number } | null;
}

export function desiredMethods(plan: StaticPlan): DesiredMethod[] {
  const byName = new Map<string, DesiredMethod>();
  for (const rate of plan.rates) {
    const name = methodName(rate);
    byName.set(name, {
      name,
      description: rate.description || null,
      price: rate.price,
      currency: plan.currency,
      weight:
        rate.kind === "weight"
          ? { min: rate.min_grams ?? 0, max: rate.max_grams ?? 0 }
          : null,
    });
  }
  return [...byName.values()];
}

/** A method definition read back from Shopify. */
export interface CurrentMethod {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  /** Null when the rate comes from a carrier (a participant), not a price. */
  price: { amount: string; currencyCode: string } | null;
  /** Grams. Null when there's no weight condition. */
  weight: { min: number | null; max: number | null } | null;
}

function sameAmount(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

function sameMethod(current: CurrentMethod, desired: DesiredMethod): boolean {
  return (
    current.active &&
    (current.description ?? null) === desired.description &&
    current.price !== null &&
    current.price.currencyCode === desired.currency &&
    sameAmount(current.price.amount, desired.price)
  );
}

function sameWeight(current: CurrentMethod, desired: DesiredMethod): boolean {
  if (!desired.weight) return current.weight === null;
  return (
    current.weight !== null &&
    current.weight.min === desired.weight.min &&
    current.weight.max === desired.weight.max
  );
}

export interface ZoneMethodChanges {
  create: DesiredMethod[];
  update: Array<{ id: string; method: DesiredMethod }>;
  delete: string[];
}

/**
 * What to change in one zone so its Hikyaku method definitions match
 * `desired`. Only the app's own methods (by name prefix) are compared or
 * deleted. A method whose weight condition changed is deleted and created
 * again, rather than editing its conditions in place.
 */
export function diffZoneMethods(
  current: CurrentMethod[],
  desired: DesiredMethod[],
): ZoneMethodChanges {
  const changes: ZoneMethodChanges = { create: [], update: [], delete: [] };
  const own = new Map<string, CurrentMethod>();
  for (const method of current) {
    if (!isOwnName(method.name)) continue;
    // Two methods with one name (a hand-made copy): keep the first.
    if (own.has(method.name)) changes.delete.push(method.id);
    else own.set(method.name, method);
  }
  for (const method of desired) {
    const existing = own.get(method.name);
    own.delete(method.name);
    if (!existing) {
      changes.create.push(method);
    } else if (!sameWeight(existing, method)) {
      changes.delete.push(existing.id);
      changes.create.push(method);
    } else if (!sameMethod(existing, method)) {
      changes.update.push({ id: existing.id, method });
    }
  }
  for (const leftover of own.values()) changes.delete.push(leftover.id);
  return changes;
}

export interface CurrentZone {
  id: string;
  name: string;
  countries: Array<{ code: string | null; restOfWorld: boolean }>;
  methods: CurrentMethod[];
}

export interface CurrentLocationGroup {
  id: string;
  locationIds: string[];
  zones: CurrentZone[];
}

export interface CurrentProfile {
  id: string;
  name: string;
  groups: CurrentLocationGroup[];
}

/** A Shopify location Hikyaku delivers from (mapped to a warehouse). */
export interface MappedLocation {
  id: string;
  countryCode: string;
}

// The subset of DeliveryProfileInput the app sends.
export interface MethodDefinitionInput {
  id?: string;
  name: string;
  description: string | null;
  active: boolean;
  rateDefinition: { price: { amount: string; currencyCode: string } };
  weightConditionsToCreate?: Array<{
    criteria: { value: number; unit: "GRAMS" };
    operator: "GREATER_THAN_OR_EQUAL_TO" | "LESS_THAN_OR_EQUAL_TO";
  }>;
}

export interface ZoneInput {
  id?: string;
  name?: string;
  countries?: Array<{ code: string; includeAllProvinces: true }>;
  methodDefinitionsToCreate?: MethodDefinitionInput[];
  methodDefinitionsToUpdate?: MethodDefinitionInput[];
}

export interface ProfileInput {
  locationGroupsToUpdate?: Array<{
    id: string;
    zonesToCreate?: ZoneInput[];
    zonesToUpdate?: ZoneInput[];
  }>;
  methodDefinitionsToDelete?: string[];
  zonesToDelete?: string[];
}

export interface ProfileUpdate {
  profileId: string;
  profileName: string;
  input: ProfileInput;
}

function methodInput(
  method: DesiredMethod,
  id?: string,
): MethodDefinitionInput {
  const input: MethodDefinitionInput = {
    ...(id ? { id } : {}),
    name: method.name,
    description: method.description,
    active: true,
    rateDefinition: {
      price: { amount: method.price, currencyCode: method.currency },
    },
  };
  // Conditions can only be added when creating; a changed weight band is
  // deleted and created again (diffZoneMethods).
  if (method.weight && !id) {
    input.weightConditionsToCreate = [
      {
        criteria: { value: method.weight.min, unit: "GRAMS" },
        operator: "GREATER_THAN_OR_EQUAL_TO",
      },
      {
        criteria: { value: method.weight.max, unit: "GRAMS" },
        operator: "LESS_THAN_OR_EQUAL_TO",
      },
    ];
  }
  return input;
}

/** The name of a zone the app creates for a country no zone covered. */
export function zoneName(countryCode: string): string {
  return `${STATIC_NAME_PREFIX}${countryCode}`;
}

/**
 * The changes to each delivery profile so Hikyaku rates are offered from
 * every location group that ships from a mapped location, and nowhere else.
 *
 * In such a group, for each country a mapped location is in, the rates go
 * into the zone that lists that country, else the group's Rest of World
 * zone, else a new zone for the country alone. (Creating a zone for a
 * country that Rest of World covers would take it out of Rest of World and
 * hide the merchant's own rates there.) Every other zone loses its Hikyaku
 * methods, and a zone the app created that's no longer needed is deleted.
 *
 * Pass `desired: []` to remove everything the app wrote.
 */
export function planProfileUpdates(
  profiles: CurrentProfile[],
  mappedLocations: MappedLocation[],
  desired: DesiredMethod[],
): ProfileUpdate[] {
  const countryOf = new Map(
    mappedLocations.map((location) => [location.id, location.countryCode]),
  );
  const updates: ProfileUpdate[] = [];

  for (const profile of profiles) {
    const input: ProfileInput = {};
    const groupsToUpdate: NonNullable<ProfileInput["locationGroupsToUpdate"]> =
      [];
    const methodsToDelete: string[] = [];
    const zonesToDelete: string[] = [];

    for (const group of profile.groups) {
      const countries = new Set<string>();
      if (desired.length > 0) {
        for (const id of group.locationIds) {
          const country = countryOf.get(id);
          if (country) countries.add(country);
        }
      }

      const targets = new Set<string>();
      const zonesToCreate: ZoneInput[] = [];
      for (const country of [...countries].sort()) {
        const zone =
          group.zones.find((candidate) =>
            candidate.countries.some((c) => c.code === country),
          ) ??
          group.zones.find((candidate) =>
            candidate.countries.some((c) => c.restOfWorld),
          );
        if (zone) {
          targets.add(zone.id);
        } else {
          zonesToCreate.push({
            name: zoneName(country),
            countries: [{ code: country, includeAllProvinces: true }],
            methodDefinitionsToCreate: desired.map((method) =>
              methodInput(method),
            ),
          });
        }
      }

      const zonesToUpdate: ZoneInput[] = [];
      for (const zone of group.zones) {
        const wanted = targets.has(zone.id);
        if (!wanted && isOwnName(zone.name)) {
          zonesToDelete.push(zone.id);
          continue;
        }
        const changes = diffZoneMethods(zone.methods, wanted ? desired : []);
        methodsToDelete.push(...changes.delete);
        if (changes.create.length > 0 || changes.update.length > 0) {
          zonesToUpdate.push({
            id: zone.id,
            ...(changes.create.length > 0
              ? {
                  methodDefinitionsToCreate: changes.create.map((method) =>
                    methodInput(method),
                  ),
                }
              : {}),
            ...(changes.update.length > 0
              ? {
                  methodDefinitionsToUpdate: changes.update.map(
                    ({ id, method }) => methodInput(method, id),
                  ),
                }
              : {}),
          });
        }
      }

      if (zonesToCreate.length > 0 || zonesToUpdate.length > 0) {
        groupsToUpdate.push({
          id: group.id,
          ...(zonesToCreate.length > 0 ? { zonesToCreate } : {}),
          ...(zonesToUpdate.length > 0 ? { zonesToUpdate } : {}),
        });
      }
    }

    if (groupsToUpdate.length > 0)
      input.locationGroupsToUpdate = groupsToUpdate;
    if (methodsToDelete.length > 0)
      input.methodDefinitionsToDelete = methodsToDelete;
    if (zonesToDelete.length > 0) input.zonesToDelete = zonesToDelete;
    if (Object.keys(input).length > 0) {
      updates.push({ profileId: profile.id, profileName: profile.name, input });
    }
  }
  return updates;
}

/** Converts a Shopify weight to grams. */
export function toGrams(value: number, unit: string): number {
  switch (unit) {
    case "KILOGRAMS":
      return value * 1000;
    case "POUNDS":
      return value * 453.59237;
    case "OUNCES":
      return value * 28.349523125;
    default:
      return value;
  }
}

/**
 * The Function's map of the app's method definitions: each name to the
 * service it belongs to, the name to show instead, and its distance band in
 * km. Written to the delivery customization's `rates` metafield.
 */
export interface FunctionRates {
  v: 1;
  r: Record<
    string,
    { s: string; n: string; k: "f" | "d" | "w"; a?: number; b?: number }
  >;
}

export function functionRates(plan: StaticPlan): FunctionRates {
  const r: FunctionRates["r"] = {};
  for (const rate of plan.rates) {
    const kind =
      rate.kind === "flat" ? "f" : rate.kind === "distance" ? "d" : "w";
    r[methodName(rate)] = {
      s: rate.service_id,
      n: rate.service_name,
      k: kind,
      ...(kind === "d" ? { a: rate.min_km ?? 0, b: rate.max_km ?? 0 } : {}),
    };
  }
  return { v: 1, r };
}

/** Method name → rate code, for recognising a static rate on an order. */
export function staticRateCodes(plan: StaticPlan): Record<string, string> {
  return Object.fromEntries(
    plan.rates.map((rate) => [methodName(rate), rate.code]),
  );
}
