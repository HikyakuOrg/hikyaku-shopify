import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  describeFailure,
  fetchShippingRates,
  hikyakuAccess,
  saveShippingRates,
} from "./hikyaku-api.server";
import {
  ensureCarrierService,
  removeCarrierService,
} from "./carrier-service.server";
import { capabilityFromPlan, type RatePath } from "./rate-path";
import { removeHikyakuRates } from "./shipping-rates.server";
import { removeStaticRates, syncStaticRates } from "./static-rates.server";
import { getCarrierService, getShopInfo } from "./shopify-admin.server";

// Puts Hikyaku rates at checkout in the state the merchant asked for, on the
// path the shop's plan allows (HIK-217), and switches paths when the plan
// changes: on saving the Shipping rates screen, on loading it, and on
// shop/update.
//
// A switch takes the old path down before putting the new one up, so the two
// are never both showing Hikyaku rates. If the second step fails, the shop
// has no Hikyaku rates until it's retried (the next load of the screen or
// shop/update); the failure is kept in ShippingRates.error and the screen
// shows it.

export interface ApplyRatesResult {
  ok: boolean;
  enabled: boolean;
  path: RatePath | null;
  /** Why this path, in words for the merchant. */
  reason: string | null;
  errors: string[];
  /** Static path: some service area is only a bounding box at checkout. */
  bboxFallback: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tells hikyaku-api the shop's path and currency when they changed: the
 * static plan needs the path (and band settings), and the callback prices in
 * the shop currency.
 */
async function syncApiSettings(
  shop: string,
  path: RatePath,
  currency: string,
): Promise<string | null> {
  const access = await hikyakuAccess(shop);
  if (!access) return "This store isn't connected to Hikyaku.";
  const current = await fetchShippingRates(
    access.accessToken,
    access.organisationSlug,
    shop,
    currency,
  );
  if (!current.ok) {
    return describeFailure(current, "read the Hikyaku rate settings");
  }
  const { settings } = current.data;
  if (settings.path === path && settings.shop_currency === currency) {
    return null;
  }
  const saved = await saveShippingRates(
    access.accessToken,
    access.organisationSlug,
    shop,
    { ...settings, path, shop_currency: currency },
  );
  if (saved.ok) return null;
  if (saved.code === "band_settings_invalid") {
    return "This store's plan needs fixed-price rates: set the band sizes on the Shipping rates screen.";
  }
  if (saved.code === "service_missing_currency") {
    return `A chosen service has no price in ${currency}. Add one in the Hikyaku dashboard.`;
  }
  return describeFailure(saved, "save the Hikyaku rate settings");
}

/**
 * Turns Hikyaku rates on (on the path the plan allows, switching if needed)
 * or off (removing both paths). Records the outcome in ShippingRates.
 */
export async function applyRates(
  admin: AdminApiContext,
  shop: string,
  options: { enabled: boolean },
): Promise<ApplyRatesResult> {
  const state = await prisma.shippingRates.findUnique({ where: { shop } });

  if (!options.enabled) {
    const errors = await removeHikyakuRates(admin, shop);
    await prisma.shippingRates.upsert({
      where: { shop },
      create: { shop, enabled: false, error: errors.join(" ") || null },
      update: { enabled: false, error: errors.join(" ") || null },
    });
    return {
      ok: errors.length === 0,
      enabled: false,
      path: (state?.path as RatePath | null) ?? null,
      reason: null,
      errors,
      bboxFallback: false,
    };
  }

  const info = await getShopInfo(admin);
  let capability = capabilityFromPlan(
    info.plan,
    process.env.HIKYAKU_RATES_PATH,
  );
  // Shopify switches a carrier service off itself when the plan stops
  // qualifying.
  if (
    capability.path !== "static" &&
    state?.path === "live" &&
    state.carrierServiceId
  ) {
    const carrier = await getCarrierService(
      admin,
      state.carrierServiceId,
    ).catch(() => null);
    if (carrier && !carrier.active && state.enabled) {
      capability = {
        path: "static",
        reason:
          "Shopify switched off carrier-calculated shipping for this store's plan",
      };
    }
  }

  const errors: string[] = [];
  // Where the shop stands until a step succeeds: a failed switch leaves it
  // on its old path, to be retried.
  let path = (state?.path as RatePath | null) ?? null;
  let reason = capability.reason;
  let bboxFallback = false;

  if (capability.path === "live" || capability.path === "probe") {
    // Register (or keep) the carrier service switched off first: on a plan
    // without carrier-calculated shipping Shopify refuses, and the static
    // rates stay as they are.
    const registered = await ensureCarrierService(admin, shop, {
      active: state?.path === "live",
    }).catch((error: unknown) => ({
      ok: false as const,
      errors: [message(error)],
    }));
    if (!registered.ok) {
      if (capability.path === "probe") {
        reason = `${capability.reason}, and Shopify didn't allow it for this store`;
        capability = { path: "static", reason };
      } else {
        errors.push(
          `Couldn't register Hikyaku's rate service with Shopify: ${registered.errors.join("; ")}`,
        );
      }
    } else {
      // Static → live: the static rates go before the carrier service
      // switches on.
      const removed =
        state?.path === "static" || state?.deliveryCustomizationId
          ? await removeStaticRates(admin, shop)
          : { ok: true as const, errors: [] };
      if (!removed.ok) {
        errors.push(...removed.errors);
      } else {
        const activated = await ensureCarrierService(admin, shop, {
          active: true,
        }).catch((error: unknown) => ({
          ok: false as const,
          errors: [message(error)],
        }));
        if (activated.ok && activated.data.active) {
          path = "live";
        } else if (capability.path === "probe") {
          reason = `${capability.reason}, and Shopify didn't allow it for this store`;
          capability = { path: "static", reason };
        } else {
          errors.push(
            `Couldn't switch on Hikyaku's rate service in Shopify: ${activated.ok ? "Shopify kept it inactive" : activated.errors.join("; ")}`,
          );
        }
      }
    }
  }

  if (capability.path === "static") {
    // Live → static: the carrier service goes first.
    const removed = await removeCarrierService(admin, shop).catch(
      (error: unknown) => ({ ok: false as const, errors: [message(error)] }),
    );
    if (!removed.ok) {
      errors.push(
        `Couldn't remove Hikyaku's rate service from Shopify: ${removed.errors.join("; ")}`,
      );
    } else {
      path = "static";
      const apiError = await syncApiSettings(shop, "static", info.currencyCode);
      if (apiError) {
        errors.push(apiError);
      } else {
        const synced = await syncStaticRates(admin, shop);
        errors.push(...synced.errors);
        bboxFallback = synced.bboxFallback;
      }
    }
  } else if (path === "live") {
    const apiError = await syncApiSettings(shop, "live", info.currencyCode);
    if (apiError) errors.push(apiError);
  }

  const error = errors.length > 0 ? errors.join(" ") : null;
  const seen = {
    shopPlan: info.plan.publicDisplayName,
    shopCurrency: info.currencyCode,
  };
  await prisma.shippingRates.upsert({
    where: { shop },
    create: { shop, enabled: true, path, error, ...seen },
    update: { enabled: true, path, error, ...seen },
  });
  return { ok: !error, enabled: true, path, reason, errors, bboxFallback };
}

/**
 * Re-checks a shop that has rates on (screen load, shop/update): switches
 * path if its plan changed, and retries whatever failed last time. Does
 * nothing for a shop with rates off.
 */
export async function reconcileRates(
  admin: AdminApiContext,
  shop: string,
): Promise<ApplyRatesResult | null> {
  const state = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { enabled: true },
  });
  if (!state?.enabled) return null;
  return applyRates(admin, shop, { enabled: true });
}
