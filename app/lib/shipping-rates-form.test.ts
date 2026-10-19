import { describe, expect, it } from "vitest";
import type { ShippingRateService } from "./hikyaku-api.server";
import {
  bandMaxField,
  bandWidthField,
  describeSettingsError,
  formatRate,
  parseSettingsForm,
} from "./shipping-rates-form";

const perKm: ShippingRateService = {
  id: "km",
  name: "Standard",
  description: null,
  unit: "per_km",
  amount: "0.50",
  currency: "AUD",
};
const flat: ShippingRateService = {
  id: "flat",
  name: "Same Day",
  description: "Today",
  unit: "per_delivery",
  amount: "15",
  currency: "AUD",
};
const noPrice: ShippingRateService = {
  id: "usd",
  name: "Overseas",
  description: null,
  unit: "per_kg",
  amount: null,
  currency: "AUD",
};
const services = [perKm, flat, noPrice];

function form(entries: Array<[string, string]>) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("formatRate", () => {
  it("prices per unit in the currency", () => {
    expect(formatRate(perKm)).toBe("A$0.50 / km");
    expect(formatRate(flat)).toBe("A$15.00 / delivery");
    expect(formatRate(noPrice)).toBeNull();
  });
});

describe("parseSettingsForm", () => {
  it("reads rates on with services and their bands", () => {
    expect(
      parseSettingsForm(
        form([
          ["enabled", "on"],
          ["service", "km"],
          ["service", "flat"],
          [bandWidthField("km"), "5"],
          [bandMaxField("km"), "30"],
        ]),
        services,
        { needsBands: true },
      ),
    ).toEqual({
      ok: true,
      enabled: true,
      serviceIds: ["km", "flat"],
      bandSettings: { km: { band_width: 5, max: 30 } },
    });
  });

  it("needs a service to turn rates on, but not to turn them off", () => {
    expect(
      parseSettingsForm(form([["enabled", "on"]]), services, {
        needsBands: false,
      }),
    ).toEqual({ ok: false, error: "Choose at least one service to offer." });
    expect(
      parseSettingsForm(form([]), services, { needsBands: false }),
    ).toEqual({ ok: true, enabled: false, serviceIds: [], bandSettings: {} });
  });

  it("refuses a service with no price in the shop currency, or an unknown one", () => {
    expect(
      parseSettingsForm(form([["service", "usd"]]), services, {
        needsBands: false,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no price in AUD/),
    });
    expect(
      parseSettingsForm(form([["service", "gone"]]), services, {
        needsBands: false,
      }).ok,
    ).toBe(false);
  });

  it("requires sensible bands on the static path only", () => {
    const missing = form([
      ["enabled", "on"],
      ["service", "km"],
      [bandWidthField("km"), "0"],
      [bandMaxField("km"), "30"],
    ]);
    expect(parseSettingsForm(missing, services, { needsBands: true }).ok).toBe(
      false,
    );
    expect(
      parseSettingsForm(missing, services, { needsBands: false }),
    ).toMatchObject({ ok: true, bandSettings: {} });
    expect(
      parseSettingsForm(
        form([
          ["enabled", "on"],
          ["service", "km"],
          [bandWidthField("km"), "1"],
          [bandMaxField("km"), "100"],
        ]),
        services,
        { needsBands: true },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/100 bands/) });
  });
});

describe("describeSettingsError", () => {
  it("names the services hikyaku-api complained about", () => {
    expect(
      describeSettingsError(
        {
          status: 422,
          code: "service_missing_currency",
          serviceIds: ["km"],
          detail: "",
        },
        services,
        "AUD",
      ),
    ).toBe("Standard has no price in AUD. Add one in the Hikyaku dashboard.");
  });

  it("shows hikyaku-api's sentence for too many static rates", () => {
    expect(
      describeSettingsError(
        {
          status: 422,
          code: "too_many_rates",
          serviceIds: ["km"],
          detail:
            "HTTP 422: These services make 230 checkout rates, and Shopify has room for 200. Use wider bands, a lower maximum or fewer services.",
        },
        services,
        "AUD",
      ),
    ).toBe(
      "These services make 230 checkout rates, and Shopify has room for 200. Use wider bands, a lower maximum or fewer services.",
    );
  });

  it("explains a shop held by another organisation", () => {
    expect(
      describeSettingsError(
        { status: 409, detail: "HTTP 409" },
        services,
        "AUD",
      ),
    ).toMatch(/another Hikyaku organisation/);
  });
});
