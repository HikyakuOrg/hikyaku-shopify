import { describe, expect, it } from "vitest";
import {
  covers,
  decide,
  haversineKm,
  inRing,
  type CoverageConfig,
  type DeliveryGroupInput,
  type FunctionInput,
  type RatesConfig,
} from "./hikyaku-rates";

// Melbourne CBD warehouse; a square service area around it (about ±0.1°).
const MELBOURNE = { la: -37.8136, ln: 144.9631 };
const SQUARE = [144.86, -37.91, 145.06, -37.91, 145.06, -37.71, 144.86, -37.71];
const INSIDE = { latitude: -37.84, longitude: 144.99 }; // ~3.8 km away
const FAR_INSIDE = { latitude: -37.88, longitude: 145.05 }; // ~10.6 km away
const OUTSIDE = { latitude: -37.6, longitude: 145.2 };

const rates: RatesConfig = {
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
    "Hikyaku · Standard · 10–15 km": {
      s: "km1",
      n: "Standard",
      k: "d",
      a: 10,
      b: 15,
    },
    "Hikyaku · Bulky · 0–2.5 kg": { s: "kg1", n: "Bulky", k: "w" },
    "Hikyaku · Bulky · 2.5–5 kg": { s: "kg1", n: "Bulky", k: "w" },
  },
};

const coverage: CoverageConfig = {
  v: 1,
  w: [{ id: "mel", ...MELBOURNE, e: false, p: [SQUARE] }],
};

function option(title: string, amount = "10.00") {
  return {
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    code: title,
    cost: { amount },
  };
}

const MERCHANT = option("Standard Post", "9.95");
const ALL_OURS = [
  option("Hikyaku · Same Day", "15.00"),
  option("Hikyaku · Standard · 0–5 km", "5.00"),
  option("Hikyaku · Standard · 5–10 km", "10.00"),
  option("Hikyaku · Standard · 10–15 km", "15.00"),
];

function input(
  address: DeliveryGroupInput["deliveryAddress"],
  options = [MERCHANT, ...ALL_OURS],
  overrides: Partial<FunctionInput> = {},
): FunctionInput {
  return {
    currency: "AUD",
    presentmentCurrencyRate: "1.0",
    groups: [{ deliveryAddress: address, deliveryOptions: options }],
    rates,
    coverage,
    ...overrides,
  };
}

const hidden = (operations: ReturnType<typeof decide>) =>
  operations
    .flatMap((op) =>
      "deliveryOptionHide" in op
        ? [op.deliveryOptionHide.deliveryOptionHandle]
        : [],
    )
    .sort();
const renamed = (operations: ReturnType<typeof decide>) =>
  Object.fromEntries(
    operations.flatMap((op) =>
      "deliveryOptionRename" in op
        ? [
            [
              op.deliveryOptionRename.deliveryOptionHandle,
              op.deliveryOptionRename.title,
            ],
          ]
        : [],
    ),
  );
const handlesOf = (...titles: string[]) =>
  titles.map((title) => option(title).handle).sort();

describe("geometry", () => {
  it("measures straight-line distance", () => {
    expect(haversineKm(-37.8136, 144.9631, -33.8688, 151.2093)).toBeCloseTo(
      713.4,
      0,
    );
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
  });

  it("tests points against a ring", () => {
    expect(inRing(144.99, -37.84, SQUARE)).toBe(true);
    expect(inRing(145.2, -37.6, SQUARE)).toBe(false);
  });

  it("covers everywhere for a warehouse with a floater, and by bounding box when flagged", () => {
    expect(covers({ id: "x", la: 0, ln: 0, e: true }, 50, 50)).toBe(true);
    expect(
      covers(
        { id: "x", la: 0, ln: 0, b: [[144.86, -37.91, 145.06, -37.71]] },
        -37.84,
        144.99,
      ),
    ).toBe(true);
    expect(
      covers(
        { id: "x", la: 0, ln: 0, b: [[144.86, -37.91, 145.06, -37.71]] },
        -37.6,
        145.2,
      ),
    ).toBe(false);
  });
});

describe("decide", () => {
  it("inside the area: keeps the flat rate and the band containing the address, renamed", () => {
    const operations = decide(input(INSIDE));
    expect(hidden(operations)).toEqual(
      handlesOf(
        "Hikyaku · Standard · 5–10 km",
        "Hikyaku · Standard · 10–15 km",
      ),
    );
    expect(renamed(operations)).toEqual({
      [option("Hikyaku · Same Day").handle]: "Same Day",
      [option("Hikyaku · Standard · 0–5 km").handle]: "Standard",
    });
  });

  it("picks the band by distance", () => {
    expect(hidden(decide(input(FAR_INSIDE)))).toEqual(
      handlesOf("Hikyaku · Standard · 0–5 km", "Hikyaku · Standard · 5–10 km"),
    );
  });

  it("beyond the last band hides that service but keeps the others", () => {
    const tooFar = { ...coverage, w: [{ ...coverage.w[0], e: true }] };
    const operations = decide(
      input({ latitude: -38.1, longitude: 145.3 }, undefined, {
        coverage: tooFar,
      }),
    );
    expect(hidden(operations)).toEqual(
      handlesOf(
        "Hikyaku · Standard · 0–5 km",
        "Hikyaku · Standard · 5–10 km",
        "Hikyaku · Standard · 10–15 km",
      ),
    );
    expect(Object.values(renamed(operations))).toEqual(["Same Day"]);
  });

  it("outside the area: hides every Hikyaku option and nothing else", () => {
    const operations = decide(input(OUTSIDE));
    expect(hidden(operations)).toEqual(ALL_OURS.map((o) => o.handle).sort());
    expect(hidden(operations)).not.toContain(MERCHANT.handle);
  });

  it("a warehouse covering everywhere keeps its rates anywhere", () => {
    const floater = { ...coverage, w: [{ ...coverage.w[0], e: true }] };
    const operations = decide(
      input({ latitude: -37.75, longitude: 145.04 }, undefined, {
        coverage: floater,
      }),
    );
    expect(hidden(operations)).not.toContain(
      option("Hikyaku · Same Day").handle,
    );
  });

  it("uses the nearest warehouse", () => {
    const sydney = { id: "syd", la: -33.8688, ln: 151.2093, e: true };
    // Sydney covers everywhere, but Melbourne is nearer to a Melbourne
    // address outside Melbourne's area, so nothing shows.
    expect(
      hidden(
        decide(
          input(OUTSIDE, undefined, {
            coverage: { v: 1, w: [coverage.w[0], sydney] },
          }),
        ),
      ),
    ).toEqual(ALL_OURS.map((o) => o.handle).sort());
  });

  it("at a band edge keeps only the cheaper band", () => {
    const edge = { ...coverage, w: [{ ...coverage.w[0], e: true }] };
    const atFive = decide({
      ...input(null, undefined, { coverage: edge }),
      groups: [
        {
          // Due north of the warehouse by 5 km exactly.
          deliveryAddress: {
            latitude: MELBOURNE.la + 5 / 111.195,
            longitude: MELBOURNE.ln,
          },
          deliveryOptions: ALL_OURS,
        },
      ],
    });
    expect(hidden(atFive)).toEqual(
      handlesOf(
        "Hikyaku · Standard · 5–10 km",
        "Hikyaku · Standard · 10–15 km",
      ),
    );
  });

  it("keeps one weight band per service (the cheapest) when both pass Shopify's conditions", () => {
    const operations = decide(
      input(INSIDE, [
        option("Hikyaku · Bulky · 0–2.5 kg", "7.50"),
        option("Hikyaku · Bulky · 2.5–5 kg", "12.00"),
      ]),
    );
    expect(hidden(operations)).toEqual(handlesOf("Hikyaku · Bulky · 2.5–5 kg"));
  });

  it.each([
    ["no coordinates", { latitude: null, longitude: null }],
    ["no address", null],
  ])("%s: hides every Hikyaku option", (_, address) => {
    expect(hidden(decide(input(address)))).toEqual(
      ALL_OURS.map((o) => o.handle).sort(),
    );
  });

  it("another checkout currency: hides every Hikyaku option", () => {
    expect(
      hidden(decide(input(INSIDE, undefined, { currency: "USD" }))),
    ).toEqual(ALL_OURS.map((o) => o.handle).sort());
    expect(
      hidden(
        decide(input(INSIDE, undefined, { presentmentCurrencyRate: "0.65" })),
      ),
    ).toEqual(ALL_OURS.map((o) => o.handle).sort());
  });

  it("fails closed on a missing or malformed metafield", () => {
    for (const overrides of [
      { coverage: null },
      { coverage: { v: 1, w: [{ id: "x" }] } },
      { rates: null },
      { rates: { v: 2 } },
    ]) {
      const operations = decide(input(INSIDE, undefined, overrides));
      expect(hidden(operations)).toEqual(ALL_OURS.map((o) => o.handle).sort());
      expect(renamed(operations)).toEqual({});
    }
  });

  it("does nothing for a checkout without Hikyaku options", () => {
    expect(decide(input(INSIDE, [MERCHANT]))).toEqual([]);
  });

  it("stays well inside the instruction budget for a full coverage export", () => {
    // ~10 KB of polygon: 40 rings of 30 points.
    const ring = Array.from({ length: 30 }, (_, i) => [
      144.96 + 0.1 * Math.cos((2 * Math.PI * i) / 30),
      -37.81 + 0.1 * Math.sin((2 * Math.PI * i) / 30),
    ]).flat();
    const heavy: CoverageConfig = {
      v: 1,
      w: [
        { id: "mel", ...MELBOURNE, p: Array.from({ length: 40 }, () => ring) },
      ],
    };
    const started = performance.now();
    for (let i = 0; i < 1000; i++)
      decide(input(OUTSIDE, undefined, { coverage: heavy }));
    // A thousand runs in well under a second on Node; the Wasm limit is 11M
    // instructions per run.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
