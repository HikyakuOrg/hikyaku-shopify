import { describe, expect, it } from "vitest";
import {
  findHikyakuShippingLine,
  parseRateCode,
  type PayloadShippingLine,
} from "./hikyaku-shipping-line";

describe("parseRateCode", () => {
  it("reads a service id", () => {
    expect(parseRateCode("hikyaku:svc_1")).toEqual({
      serviceId: "svc_1",
      band: null,
    });
  });

  it("reads distance and weight bands", () => {
    expect(parseRateCode("hikyaku:svc_1:d:5-10")).toEqual({
      serviceId: "svc_1",
      band: { kind: "distance", min: 5, max: 10 },
    });
    expect(parseRateCode("hikyaku:svc_1:w:0-2500")).toEqual({
      serviceId: "svc_1",
      band: { kind: "weight", min: 0, max: 2500 },
    });
    expect(parseRateCode("hikyaku:svc_1:d:2.5-5")?.band).toEqual({
      kind: "distance",
      min: 2.5,
      max: 5,
    });
  });

  it("rejects anything else", () => {
    for (const code of [
      null,
      undefined,
      "",
      "Standard",
      "hikyaku:",
      "hikyaku:svc_1:x:1-2",
      "hikyaku:svc_1:d:5",
      "hikyaku:svc_1:d:5-10:extra",
      "HIKYAKU:svc_1",
    ]) {
      expect(parseRateCode(code)).toBeNull();
    }
  });
});

function line(overrides: Partial<PayloadShippingLine>): PayloadShippingLine {
  return { title: "Standard", price: "10.00", code: "Standard", ...overrides };
}

describe("findHikyakuShippingLine", () => {
  it("finds a carrier service rate by its code", () => {
    expect(
      findHikyakuShippingLine(
        [
          line({ title: "Express", code: "Express", source: "shopify" }),
          line({
            title: "Hikyaku Same Day",
            code: "hikyaku:svc_1",
            source: "Hikyaku",
            carrier_identifier: "abc123",
            price: "12.50",
            discounted_price: "0.00",
            price_set: {
              shop_money: { amount: "12.50", currency_code: "AUD" },
            },
            discounted_price_set: {
              shop_money: { amount: "0.00", currency_code: "AUD" },
            },
          }),
        ],
        { shopCurrency: "AUD" },
      ),
    ).toEqual({
      service_id: "svc_1",
      path: "live",
      price: "12.50",
      discounted_price: "0.00",
      currency: "AUD",
      title: "Hikyaku Same Day",
    });
  });

  it("prices in the shop currency when the shopper paid in another", () => {
    const found = findHikyakuShippingLine(
      [
        line({
          code: "hikyaku:svc_1",
          price: "8.00",
          price_set: { shop_money: { amount: "12.50", currency_code: "AUD" } },
        }),
      ],
      { shopCurrency: "AUD" },
    );
    expect(found?.price).toBe("12.50");
    expect(found?.discounted_price).toBe("12.50");
  });

  it("falls back to the plain price and the shop currency", () => {
    expect(
      findHikyakuShippingLine(
        [line({ code: "hikyaku:svc_1", price: "9.00" })],
        {
          shopCurrency: "NZD",
        },
      ),
    ).toMatchObject({
      price: "9.00",
      discounted_price: "9.00",
      currency: "NZD",
    });
  });

  it("finds a static rate by the name the app wrote it under", () => {
    const staticRates = new Map([
      ["Hikyaku Standard 5–10 km", "hikyaku:svc_2:d:5-10"],
    ]);
    expect(
      findHikyakuShippingLine(
        [
          line({
            title: "Hikyaku Standard",
            code: "Hikyaku Standard 5–10 km",
            source: "shopify",
          }),
        ],
        { shopCurrency: "AUD", staticRates },
      ),
    ).toMatchObject({ service_id: "svc_2", path: "static" });
    // Matched by title when the code isn't the method's name.
    expect(
      findHikyakuShippingLine(
        [line({ title: "Hikyaku Standard 5–10 km", code: null })],
        { shopCurrency: "AUD", staticRates },
      ),
    ).toMatchObject({ service_id: "svc_2", path: "static" });
  });

  it("is null for an order that chose another rate", () => {
    expect(
      findHikyakuShippingLine(
        [line({}), line({ title: "Pickup", code: "pickup" })],
        { shopCurrency: "AUD", staticRates: new Map() },
      ),
    ).toBeNull();
    expect(findHikyakuShippingLine([], { shopCurrency: "AUD" })).toBeNull();
  });
});
