// Pure: which way a shop gets Hikyaku rates at checkout (HIK-217), decided
// from what its plan can do, never asked of the merchant.
//
// - live: a carrier service, so Shopify asks hikyaku-api for an exact quote
//   at every checkout. Needs third-party carrier-calculated shipping:
//   Advanced, Plus, or Grow with yearly billing or the paid add-on.
// - static: rates written into the shop's delivery profiles and filtered by
//   the Function. Works on every plan.
//
// Shopify doesn't expose carrier-calculated shipping as a field, so the plan
// name decides where it can, and where it can't (Grow, trials) the app tries
// to register the carrier service and falls back to static if Shopify
// refuses.

export type RatePath = "live" | "static";

export interface ShopPlan {
  publicDisplayName: string;
  partnerDevelopment: boolean;
  shopifyPlus: boolean;
}

export type Capability =
  { path: RatePath; reason: string } | { path: "probe"; reason: string };

/** Plans that always include carrier-calculated shipping. */
const LIVE_PLANS = new Set([
  "advanced",
  "plus",
  "plus trial",
  "agentic enterprise",
  "development",
]);

/** Plans that never do. */
const STATIC_PLANS = new Set(["basic", "starter", "lite", "retail"]);

/**
 * The path a plan allows. A development store reports the plan it mirrors
 * ("Basic", "Advanced"), so it gets that plan's path even though Shopify
 * would let any development store register a carrier service: it then
 * behaves as the real plan would. `override` (HIKYAKU_RATES_PATH) forces a
 * path for testing.
 */
export function capabilityFromPlan(
  plan: ShopPlan,
  override?: string | null,
): Capability {
  if (override === "live" || override === "static") {
    return { path: override, reason: `forced by HIKYAKU_RATES_PATH` };
  }
  const name = plan.publicDisplayName.trim();
  if (plan.shopifyPlus) {
    return {
      path: "live",
      reason: "Shopify Plus includes carrier-calculated shipping",
    };
  }
  if (LIVE_PLANS.has(name.toLowerCase())) {
    return {
      path: "live",
      reason: `the ${name} plan includes carrier-calculated shipping`,
    };
  }
  if (STATIC_PLANS.has(name.toLowerCase())) {
    return {
      path: "static",
      reason: `the ${name} plan doesn't include carrier-calculated shipping`,
    };
  }
  return {
    path: "probe",
    reason: `the ${name} plan includes carrier-calculated shipping only with yearly billing or the add-on`,
  };
}

/**
 * Shopify deactivates a carrier service when the shop's plan stops
 * qualifying. Seeing ours inactive while rates are on is how a downgrade
 * shows up.
 */
export function carrierServiceDeactivated(state: {
  enabled: boolean;
  path: string | null;
  carrierServiceActive: boolean | null;
}): boolean {
  return (
    state.enabled &&
    state.path === "live" &&
    state.carrierServiceActive === false
  );
}
