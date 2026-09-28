import { describe, expect, it } from "vitest";
import {
  countUnmapped,
  countryCodeForName,
  distanceKm,
  mappingValue,
  parseMappingValue,
  suggestWarehouse,
  syncInput,
  type MappableLocation,
} from "./location-mapping";

function location(
  id: string,
  countryCode: string | null,
  latitude: number | null,
  longitude: number | null,
  flags: Partial<
    Pick<MappableLocation, "isActive" | "fulfillsOnlineOrders">
  > = {},
): MappableLocation {
  return {
    id,
    name: id,
    isActive: flags.isActive ?? true,
    fulfillsOnlineOrders: flags.fulfillsOnlineOrders ?? true,
    address: { countryCode, latitude, longitude },
  };
}

function warehouse(id: string, country: string, lat: number, lon: number) {
  return { id, country, lat, lon };
}

const berlin = location("berlin", "DE", 52.5219, 13.4132);
const tokyo = location("tokyo", "JP", 35.6762, 139.6503);
const berlinDepot = warehouse("berlin-depot", "Germany", 52.52, 13.405);

describe("distanceKm", () => {
  it("is zero for the same point", () => {
    expect(distanceKm({ lat: 1, lon: 2 }, { lat: 1, lon: 2 })).toBe(0);
  });

  it("matches a known distance (Berlin to Munich, about 504 km)", () => {
    const km = distanceKm(
      { lat: 52.52, lon: 13.405 },
      { lat: 48.1351, lon: 11.582 },
    );
    expect(km).toBeGreaterThan(500);
    expect(km).toBeLessThan(508);
  });
});

describe("suggestWarehouse", () => {
  it("suggests the warehouse near Berlin and nothing for Tokyo", () => {
    const suggestion = suggestWarehouse(berlin, [berlinDepot]);
    expect(suggestion?.warehouseId).toBe("berlin-depot");
    expect(suggestion?.distanceKm).toBeLessThan(1);
    expect(suggestWarehouse(tokyo, [berlinDepot])).toBeNull();
  });

  it("picks the nearest of several warehouses in range", () => {
    const suggestion = suggestWarehouse(berlin, [
      warehouse("further", "Germany", 52.54, 13.43),
      warehouse("nearest", "Germany", 52.522, 13.412),
    ]);
    expect(suggestion?.warehouseId).toBe("nearest");
  });

  it("ignores warehouses beyond the radius", () => {
    // About 6 km north of the location.
    const far = warehouse("far", "Germany", 52.576, 13.4132);
    expect(suggestWarehouse(berlin, [far])).toBeNull();
    expect(suggestWarehouse(berlin, [far], 10)?.warehouseId).toBe("far");
  });

  it("never suggests a warehouse across a border, however close", () => {
    // Basel (CH) and Weil am Rhein (DE) are about 4 km apart.
    const basel = location("basel", "CH", 47.5596, 7.5886);
    const weil = warehouse("weil", "Germany", 47.5947, 7.6104);
    expect(suggestWarehouse(basel, [weil])).toBeNull();
    expect(
      suggestWarehouse(basel, [warehouse("basel", "Switzerland", 47.56, 7.59)])
        ?.warehouseId,
    ).toBe("basel");
  });

  it("makes no suggestion without coordinates or a country code", () => {
    expect(
      suggestWarehouse(location("x", "DE", null, 13.4), [berlinDepot]),
    ).toBeNull();
    expect(
      suggestWarehouse(location("x", "DE", 52.5, null), [berlinDepot]),
    ).toBeNull();
    expect(
      suggestWarehouse(location("x", null, 52.5219, 13.4132), [berlinDepot]),
    ).toBeNull();
  });

  it("skips warehouses whose country name isn't recognised", () => {
    expect(
      suggestWarehouse(berlin, [warehouse("w", "Prussia", 52.52, 13.405)]),
    ).toBeNull();
  });
});

describe("countryCodeForName", () => {
  it.each([
    ["Germany", "DE"],
    ["germany", "DE"],
    ["  Australia ", "AU"],
    ["Japan", "JP"],
    ["United States", "US"],
    ["United States of America", "US"],
    ["USA", "US"],
    ["United Kingdom", "GB"],
    ["UK", "GB"],
    ["Great Britain", "GB"],
    ["Türkiye", "TR"],
    ["Turkey", "TR"],
    ["Czech Republic", "CZ"],
    ["Czechia", "CZ"],
    ["Hong Kong", "HK"],
    ["Hong Kong SAR China", "HK"],
    ["Myanmar", "MM"],
    ["Burma", "MM"],
    ["Côte d'Ivoire", "CI"],
    ["Cote d’Ivoire", "CI"],
    ["The Netherlands", "NL"],
    ["Bosnia and Herzegovina", "BA"],
    ["Bosnia & Herzegovina", "BA"],
    ["Saint Lucia", "LC"],
    ["St. Lucia", "LC"],
    ["South Korea", "KR"],
    ["New Zealand", "NZ"],
    ["AU", "AU"],
    ["de", "DE"],
  ])("%s -> %s", (name, code) => {
    expect(countryCodeForName(name)).toBe(code);
  });

  it.each([["Narnia"], [""], [null], [undefined], ["QQ"], ["European Union"]])(
    "doesn't recognise %s",
    (name) => {
      expect(countryCodeForName(name)).toBeNull();
    },
  );
});

describe("countUnmapped", () => {
  const inactive = location("inactive", "DE", null, null, { isActive: false });
  const offline = location("offline", "DE", null, null, {
    fulfillsOnlineOrders: false,
  });

  it("counts active online locations that are unmapped or not stored yet", () => {
    expect(
      countUnmapped(
        [berlin, tokyo, inactive, offline],
        [
          { external_location_id: "berlin", mode: "unmapped" },
          { external_location_id: "inactive", mode: "unmapped" },
        ],
      ),
    ).toBe(2);
  });

  it("is zero once every such location is decided", () => {
    expect(
      countUnmapped(
        [berlin, tokyo, inactive],
        [
          { external_location_id: "berlin", mode: "warehouse" },
          { external_location_id: "tokyo", mode: "not_delivered" },
        ],
      ),
    ).toBe(0);
  });
});

describe("mapping values", () => {
  it("round trips every mode", () => {
    for (const [mode, warehouseId] of [
      ["unmapped", null],
      ["not_delivered", null],
      ["warehouse", "5b0a4c6e-4f1c-4a55-9d3e-4f1f5b7c9a10"],
    ] as const) {
      expect(parseMappingValue(mappingValue(mode, warehouseId))).toEqual({
        mode,
        warehouseId,
      });
    }
  });

  it("rejects anything else", () => {
    expect(parseMappingValue("warehouse:")).toBeNull();
    expect(parseMappingValue("")).toBeNull();
    expect(parseMappingValue("Not mapped yet")).toBeNull();
    expect(parseMappingValue("somewhere")).toBeNull();
  });
});

describe("syncInput", () => {
  it("sends name and country but no mode", () => {
    expect(syncInput({ ...berlin, name: "Berlin" })).toEqual({
      external_location_id: "berlin",
      external_location_name: "Berlin",
      country_code: "DE",
    });
  });
});
