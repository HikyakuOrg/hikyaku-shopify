import { describe, expect, it } from "vitest";
import { capabilityFromPlan, carrierServiceDeactivated } from "./rate-path";

const plan = (publicDisplayName: string, extra = {}) => ({
  publicDisplayName,
  partnerDevelopment: false,
  shopifyPlus: false,
  ...extra,
});

describe("capabilityFromPlan", () => {
  it.each([
    "Advanced",
    "Plus",
    "Plus Trial",
    "Agentic Enterprise",
    "Development",
  ])("%s → live", (name) => {
    expect(capabilityFromPlan(plan(name)).path).toBe("live");
  });

  it.each(["Basic", "Starter", "Lite", "Retail"])("%s → static", (name) => {
    expect(capabilityFromPlan(plan(name)).path).toBe("static");
  });

  it.each(["Grow", "Trial", "Agentic", "Other", "Shop Component"])(
    "%s → try the carrier service",
    (name) => {
      expect(capabilityFromPlan(plan(name)).path).toBe("probe");
    },
  );

  it("Shopify Plus is live whatever the name", () => {
    expect(capabilityFromPlan(plan("Other", { shopifyPlus: true })).path).toBe(
      "live",
    );
  });

  it("a development store follows the plan it mirrors", () => {
    expect(
      capabilityFromPlan(plan("Basic", { partnerDevelopment: true })).path,
    ).toBe("static");
    expect(
      capabilityFromPlan(plan("Advanced", { partnerDevelopment: true })).path,
    ).toBe("live");
  });

  it("can be forced for testing", () => {
    expect(capabilityFromPlan(plan("Basic"), "live").path).toBe("live");
    expect(capabilityFromPlan(plan("Advanced"), "static").path).toBe("static");
    expect(capabilityFromPlan(plan("Basic"), "nonsense").path).toBe("static");
  });

  it("explains itself", () => {
    expect(capabilityFromPlan(plan("Basic")).reason).toBe(
      "the Basic plan doesn't include carrier-calculated shipping",
    );
  });
});

describe("carrierServiceDeactivated", () => {
  it("is a live shop whose carrier service Shopify switched off", () => {
    expect(
      carrierServiceDeactivated({
        enabled: true,
        path: "live",
        carrierServiceActive: false,
      }),
    ).toBe(true);
    for (const state of [
      { enabled: true, path: "live", carrierServiceActive: true },
      { enabled: true, path: "live", carrierServiceActive: null },
      { enabled: false, path: "live", carrierServiceActive: false },
      { enabled: true, path: "static", carrierServiceActive: false },
    ]) {
      expect(carrierServiceDeactivated(state)).toBe(false);
    }
  });
});
