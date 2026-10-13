import { describe, expect, it } from "vitest";
import {
  desiredMethods,
  diffZoneMethods,
  functionRates,
  methodName,
  planProfileUpdates,
  staticRateCodes,
  toGrams,
  type CurrentMethod,
  type CurrentProfile,
  type StaticPlan,
  type StaticPlanRate,
} from "./static-rates";

const flat: StaticPlanRate = {
  code: "hikyaku:flat1",
  service_id: "flat1",
  service_name: "Same Day",
  description: "Delivered today",
  kind: "flat",
  price: "15.00",
};

function distance(min: number, max: number, price: string): StaticPlanRate {
  return {
    code: `hikyaku:km1:d:${min}-${max}`,
    service_id: "km1",
    service_name: "Standard",
    description: null,
    kind: "distance",
    price,
    unit: "km",
    band_min: min,
    band_max: max,
    min_km: min,
    max_km: max,
  };
}

function weight(minG: number, maxG: number, price: string): StaticPlanRate {
  return {
    code: `hikyaku:kg1:w:${minG}-${maxG}`,
    service_id: "kg1",
    service_name: "Bulky",
    description: null,
    kind: "weight",
    price,
    unit: "kg",
    band_min: minG / 1000,
    band_max: maxG / 1000,
    min_grams: minG,
    max_grams: maxG,
  };
}

const plan: StaticPlan = {
  currency: "AUD",
  rates: [
    flat,
    distance(0, 5, "5.00"),
    distance(5, 10, "10.00"),
    weight(0, 2500, "7.50"),
  ],
  coverage: { v: 1, w: [] },
  bbox_fallback: false,
};

describe("methodName", () => {
  it("names flat rates after the service and bands with their range", () => {
    expect(methodName(flat)).toBe("Hikyaku · Same Day");
    expect(methodName(distance(5, 10, "1"))).toBe(
      "Hikyaku · Standard · 5–10 km",
    );
    expect(methodName(weight(0, 2500, "1"))).toBe("Hikyaku · Bulky · 0–2.5 kg");
  });

  it("uses the service's unit when the plan gives one", () => {
    expect(
      methodName({
        ...distance(8.05, 16.09, "1"),
        unit: "mi",
        band_min: 5,
        band_max: 10,
      }),
    ).toBe("Hikyaku · Standard · 5–10 mi");
  });

  it("falls back to km and kg without a unit", () => {
    expect(methodName({ ...distance(5, 10, "1"), unit: null })).toBe(
      "Hikyaku · Standard · 5–10 km",
    );
    expect(methodName({ ...weight(2500, 5000, "1"), unit: undefined })).toBe(
      "Hikyaku · Bulky · 2.5–5 kg",
    );
  });
});

function current(
  name: string,
  overrides: Partial<CurrentMethod> = {},
): CurrentMethod {
  return {
    id: `gid://shopify/DeliveryMethodDefinition/${name.length}${name.charCodeAt(name.length - 1)}`,
    name,
    description: null,
    active: true,
    price: { amount: "5.0", currencyCode: "AUD" },
    weight: null,
    ...overrides,
  };
}

describe("diffZoneMethods", () => {
  const desired = desiredMethods(plan);

  it("creates every method in a zone without any", () => {
    const changes = diffZoneMethods([current("Express")], desired);
    expect(changes.create.map((m) => m.name)).toEqual([
      "Hikyaku · Same Day",
      "Hikyaku · Standard · 0–5 km",
      "Hikyaku · Standard · 5–10 km",
      "Hikyaku · Bulky · 0–2.5 kg",
    ]);
    expect(changes.update).toEqual([]);
    expect(changes.delete).toEqual([]);
  });

  it("changes nothing when the zone already matches", () => {
    const zone = [
      current("Express"),
      current("Hikyaku · Same Day", {
        id: "a",
        description: "Delivered today",
        price: { amount: "15.0", currencyCode: "AUD" },
      }),
      current("Hikyaku · Standard · 0–5 km", { id: "b" }),
      current("Hikyaku · Standard · 5–10 km", {
        id: "c",
        price: { amount: "10", currencyCode: "AUD" },
      }),
      current("Hikyaku · Bulky · 0–2.5 kg", {
        id: "d",
        price: { amount: "7.5", currencyCode: "AUD" },
        weight: { min: 0, max: 2500 },
      }),
    ];
    expect(diffZoneMethods(zone, desired)).toEqual({
      create: [],
      update: [],
      delete: [],
    });
  });

  it("undoes hand edits, restores deleted rates and drops ones no longer offered", () => {
    const zone = [
      current("Hikyaku · Same Day", {
        id: "a",
        description: "Edited",
        price: { amount: "15", currencyCode: "AUD" },
      }),
      current("Hikyaku · Standard · 0–5 km", { id: "b", active: false }),
      current("Hikyaku · Standard · 10–15 km", { id: "old" }),
      current("Hikyaku · Bulky · 0–2.5 kg", {
        id: "d",
        price: { amount: "7.5", currencyCode: "AUD" },
        weight: { min: 0, max: 3000 },
      }),
      current("Standard", { id: "merchant" }),
    ];
    const changes = diffZoneMethods(zone, desired);
    expect(changes.update.map((u) => u.id).sort()).toEqual(["a", "b"]);
    // 5–10 km was deleted by hand; the weight band changed limits.
    expect(changes.create.map((m) => m.name)).toEqual([
      "Hikyaku · Standard · 5–10 km",
      "Hikyaku · Bulky · 0–2.5 kg",
    ]);
    expect(changes.delete.sort()).toEqual(["d", "old"]);
  });

  it("deletes duplicates of one name, keeping the first", () => {
    const changes = diffZoneMethods(
      [
        current("Hikyaku · Same Day", {
          id: "first",
          description: "Delivered today",
          price: { amount: "15", currencyCode: "AUD" },
        }),
        current("Hikyaku · Same Day", { id: "copy" }),
      ],
      desiredMethods({ ...plan, rates: [flat] }),
    );
    expect(changes).toEqual({ create: [], update: [], delete: ["copy"] });
  });

  it("removes only the app's methods when nothing is wanted", () => {
    const changes = diffZoneMethods(
      [
        current("Express", { id: "x" }),
        current("Hikyaku · Same Day", { id: "a" }),
      ],
      [],
    );
    expect(changes).toEqual({ create: [], update: [], delete: ["a"] });
  });
});

const AU_LOCATION = "gid://shopify/Location/1";
const NZ_LOCATION = "gid://shopify/Location/2";
const OTHER_LOCATION = "gid://shopify/Location/3";

function profile(groups: CurrentProfile["groups"]): CurrentProfile {
  return { id: "gid://shopify/DeliveryProfile/1", name: "General", groups };
}

describe("planProfileUpdates", () => {
  const desired = desiredMethods({ ...plan, rates: [flat] });
  const mapped = [
    { id: AU_LOCATION, countryCode: "AU" },
    { id: NZ_LOCATION, countryCode: "NZ" },
  ];

  it("adds rates to the zone listing the mapped location's country", () => {
    const updates = planProfileUpdates(
      [
        profile([
          {
            id: "group1",
            locationIds: [AU_LOCATION],
            zones: [
              {
                id: "zoneAU",
                name: "Domestic",
                countries: [{ code: "AU", restOfWorld: false }],
                methods: [current("Standard", { id: "merchant" })],
              },
              {
                id: "zoneROW",
                name: "International",
                countries: [{ code: null, restOfWorld: true }],
                methods: [],
              },
            ],
          },
        ]),
      ],
      mapped,
      desired,
    );
    expect(updates).toEqual([
      {
        profileId: "gid://shopify/DeliveryProfile/1",
        profileName: "General",
        input: {
          locationGroupsToUpdate: [
            {
              id: "group1",
              zonesToUpdate: [
                {
                  id: "zoneAU",
                  methodDefinitionsToCreate: [
                    {
                      name: "Hikyaku · Same Day",
                      description: "Delivered today",
                      active: true,
                      rateDefinition: {
                        price: { amount: "15.00", currencyCode: "AUD" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("uses Rest of World when no zone lists the country, rather than taking the country out of it", () => {
    const [update] = planProfileUpdates(
      [
        profile([
          {
            id: "group1",
            locationIds: [AU_LOCATION],
            zones: [
              {
                id: "zoneROW",
                name: "Everywhere",
                countries: [{ code: null, restOfWorld: true }],
                methods: [],
              },
            ],
          },
        ]),
      ],
      mapped,
      desired,
    );
    expect(update.input.locationGroupsToUpdate?.[0].zonesToUpdate?.[0].id).toBe(
      "zoneROW",
    );
    expect(
      update.input.locationGroupsToUpdate?.[0].zonesToCreate,
    ).toBeUndefined();
  });

  it("creates a zone for a country no zone covers", () => {
    const [update] = planProfileUpdates(
      [
        profile([
          {
            id: "group1",
            locationIds: [AU_LOCATION, NZ_LOCATION],
            zones: [
              {
                id: "zoneAU",
                name: "Domestic",
                countries: [{ code: "AU", restOfWorld: false }],
                methods: [],
              },
            ],
          },
        ]),
      ],
      mapped,
      desired,
    );
    const group = update.input.locationGroupsToUpdate?.[0];
    expect(group?.zonesToCreate).toEqual([
      {
        name: "Hikyaku · NZ",
        countries: [{ code: "NZ", includeAllProvinces: true }],
        methodDefinitionsToCreate: [
          expect.objectContaining({ name: "Hikyaku · Same Day" }),
        ],
      },
    ]);
    expect(group?.zonesToUpdate?.map((zone) => zone.id)).toEqual(["zoneAU"]);
  });

  it("leaves groups that don't ship from a mapped location alone, apart from removing stray Hikyaku rates", () => {
    const updates = planProfileUpdates(
      [
        profile([
          {
            id: "group2",
            locationIds: [OTHER_LOCATION],
            zones: [
              {
                id: "zoneAU",
                name: "Domestic",
                countries: [{ code: "AU", restOfWorld: false }],
                methods: [
                  current("Standard", { id: "merchant" }),
                  current("Hikyaku · Same Day", { id: "stray" }),
                ],
              },
              {
                id: "ourZone",
                name: "Hikyaku · NZ",
                countries: [{ code: "NZ", restOfWorld: false }],
                methods: [current("Hikyaku · Same Day", { id: "inOurZone" })],
              },
            ],
          },
        ]),
      ],
      mapped,
      desired,
    );
    expect(updates).toEqual([
      {
        profileId: "gid://shopify/DeliveryProfile/1",
        profileName: "General",
        input: {
          methodDefinitionsToDelete: ["stray"],
          zonesToDelete: ["ourZone"],
        },
      },
    ]);
  });

  it("removes everything the app wrote when nothing is desired", () => {
    const updates = planProfileUpdates(
      [
        profile([
          {
            id: "group1",
            locationIds: [AU_LOCATION],
            zones: [
              {
                id: "zoneAU",
                name: "Domestic",
                countries: [{ code: "AU", restOfWorld: false }],
                methods: [
                  current("Standard", { id: "merchant" }),
                  current("Hikyaku · Same Day", { id: "ours" }),
                ],
              },
              {
                id: "ourZone",
                name: "Hikyaku · NZ",
                countries: [{ code: "NZ", restOfWorld: false }],
                methods: [],
              },
            ],
          },
        ]),
      ],
      mapped,
      [],
    );
    expect(updates[0].input).toEqual({
      methodDefinitionsToDelete: ["ours"],
      zonesToDelete: ["ourZone"],
    });
  });

  it("returns nothing when every profile is already right", () => {
    expect(
      planProfileUpdates(
        [
          profile([
            {
              id: "group1",
              locationIds: [AU_LOCATION],
              zones: [
                {
                  id: "zoneAU",
                  name: "Domestic",
                  countries: [{ code: "AU", restOfWorld: false }],
                  methods: [
                    current("Hikyaku · Same Day", {
                      description: "Delivered today",
                      price: { amount: "15", currencyCode: "AUD" },
                    }),
                  ],
                },
              ],
            },
          ]),
        ],
        mapped,
        desired,
      ),
    ).toEqual([]);
  });

  it("adds weight conditions to a weight band", () => {
    const [update] = planProfileUpdates(
      [
        profile([
          {
            id: "group1",
            locationIds: [AU_LOCATION],
            zones: [
              {
                id: "zoneAU",
                name: "Domestic",
                countries: [{ code: "AU", restOfWorld: false }],
                methods: [],
              },
            ],
          },
        ]),
      ],
      mapped,
      desiredMethods({ ...plan, rates: [weight(2500, 5000, "9.00")] }),
    );
    expect(
      update.input.locationGroupsToUpdate?.[0].zonesToUpdate?.[0]
        .methodDefinitionsToCreate?.[0].weightConditionsToCreate,
    ).toEqual([
      {
        criteria: { value: 2500, unit: "GRAMS" },
        operator: "GREATER_THAN_OR_EQUAL_TO",
      },
      {
        criteria: { value: 5000, unit: "GRAMS" },
        operator: "LESS_THAN_OR_EQUAL_TO",
      },
    ]);
  });
});

describe("toGrams", () => {
  it("converts Shopify weight units", () => {
    expect(toGrams(2.5, "KILOGRAMS")).toBe(2500);
    expect(toGrams(100, "GRAMS")).toBe(100);
    expect(toGrams(1, "POUNDS")).toBeCloseTo(453.59);
    expect(toGrams(1, "OUNCES")).toBeCloseTo(28.35);
  });
});

describe("functionRates and staticRateCodes", () => {
  it("map each method name to its service, display name and band", () => {
    expect(functionRates(plan)).toEqual({
      v: 1,
      c: "AUD",
      r: {
        "Hikyaku · Same Day": { s: "flat1", n: "Same Day", k: "f" },
        "Hikyaku · Standard · 0–5 km": {
          s: "km1",
          n: "Standard",
          k: "d",
          a: 0,
          b: 5,
        },
        "Hikyaku · Standard · 5–10 km": {
          s: "km1",
          n: "Standard",
          k: "d",
          a: 5,
          b: 10,
        },
        "Hikyaku · Bulky · 0–2.5 kg": { s: "kg1", n: "Bulky", k: "w" },
      },
    });
    expect(staticRateCodes(plan)).toEqual({
      "Hikyaku · Same Day": "hikyaku:flat1",
      "Hikyaku · Standard · 0–5 km": "hikyaku:km1:d:0-5",
      "Hikyaku · Standard · 5–10 km": "hikyaku:km1:d:5-10",
      "Hikyaku · Bulky · 0–2.5 kg": "hikyaku:kg1:w:0-2500",
    });
  });
});
