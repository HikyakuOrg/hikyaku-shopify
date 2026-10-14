import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { Prisma } from "../generated/prisma/client";
import {
  fetchIntegrationLocations,
  fetchStaticPlan,
  hikyakuAccess,
  describeFailure,
} from "./hikyaku-api.server";
import {
  desiredMethods,
  functionRates,
  planProfileUpdates,
  staticRateCodes,
  type CurrentProfile,
  type MappedLocation,
  type ProfileUpdate,
} from "./static-rates";
import {
  FUNCTION_METAFIELD_NAMESPACE,
  createDeliveryCustomization,
  deleteDeliveryCustomization,
  listDeliveryCustomizations,
  listDeliveryProfiles,
  updateDeliveryCustomization,
  updateDeliveryProfile,
  type ShopifyDeliveryCustomization,
} from "./shopify-admin.server";

// The static path of Hikyaku rates at checkout (HIK-216): writes
// hikyaku-api's static plan into the shop's delivery profiles and the
// Function's metafields, keeps them in sync, and removes them. The pure
// decisions are in static-rates.ts.

/** The Function extension's handle (extensions/hikyaku-delivery-rates). */
export const FUNCTION_HANDLE = "hikyaku-delivery-rates";
/** The delivery customization's title, shown in Shipping and delivery. */
export const CUSTOMIZATION_TITLE = "Hikyaku rates";

/**
 * Shopify Functions read at most this much of a metafield; a bigger coverage
 * export would leave the Function without it, and it would hide every
 * Hikyaku rate.
 */
export const FUNCTION_METAFIELD_LIMIT_BYTES = 10_000;

export interface StaticSyncResult {
  ok: boolean;
  /** Mutations made; 0 when everything was already in place. */
  mutations: number;
  /** Some service area is only approximated by its bounding box. */
  bboxFallback: boolean;
  errors: string[];
}

async function applyUpdates(
  admin: AdminApiContext,
  updates: ProfileUpdate[],
  errors: string[],
): Promise<number> {
  let mutations = 0;
  for (const update of updates) {
    const result = await updateDeliveryProfile(
      admin,
      update.profileId,
      update.input,
    );
    mutations++;
    if (!result.ok) {
      errors.push(
        `Couldn't update the "${update.profileName}" shipping profile: ${result.errors.join("; ")}`,
      );
    }
  }
  return mutations;
}

async function findOwnCustomization(
  admin: AdminApiContext,
  shop: string,
): Promise<ShopifyDeliveryCustomization | null> {
  const stored = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { deliveryCustomizationId: true },
  });
  const all = await listDeliveryCustomizations(admin);
  return (
    all.find((c) => c.id === stored?.deliveryCustomizationId) ??
    all.find((c) => c.title === CUSTOMIZATION_TITLE) ??
    null
  );
}

function sameJson(current: { value: string } | null, wanted: string): boolean {
  if (!current) return false;
  try {
    return (
      JSON.stringify(JSON.parse(current.value)) ===
      JSON.stringify(JSON.parse(wanted))
    );
  } catch {
    return false;
  }
}

async function mappedLocations(
  access: { accessToken: string; organisationSlug: string },
  shop: string,
): Promise<
  { ok: true; locations: MappedLocation[] } | { ok: false; error: string }
> {
  const rows = await fetchIntegrationLocations(
    access.accessToken,
    access.organisationSlug,
    shop,
  );
  if (!rows.ok) {
    return {
      ok: false,
      error: describeFailure(rows, "read this store's locations"),
    };
  }
  return {
    ok: true,
    locations: rows.data
      .filter(
        (row) => row.mode === "warehouse" && !row.stale_at && row.country_code,
      )
      .map((row) => ({
        id: row.external_location_id,
        countryCode: row.country_code!.toUpperCase(),
      })),
  };
}

/**
 * Brings the shop's static Hikyaku rates in line with hikyaku-api's plan:
 * method definitions in every delivery profile that ships from a mapped
 * location, and the delivery customization with its coverage and rates
 * metafields. Undoes hand edits to Hikyaku rates and restores deleted ones;
 * makes no mutation when everything already matches.
 */
export async function syncStaticRates(
  admin: AdminApiContext,
  shop: string,
): Promise<StaticSyncResult> {
  const errors: string[] = [];
  const fail = async (error: string): Promise<StaticSyncResult> => {
    await recordError(shop, error);
    return { ok: false, mutations: 0, bboxFallback: false, errors: [error] };
  };

  const access = await hikyakuAccess(shop);
  if (!access) return fail("This store isn't connected to Hikyaku.");
  const plan = await fetchStaticPlan(
    access.accessToken,
    access.organisationSlug,
    shop,
  );
  if (!plan.ok) return fail(describeFailure(plan, "read the Hikyaku rates"));

  const coverage = JSON.stringify(plan.data.coverage);
  const rates = JSON.stringify(functionRates(plan.data));
  for (const [name, value] of [
    ["coverage", coverage],
    ["rates", rates],
  ]) {
    if (Buffer.byteLength(value) > FUNCTION_METAFIELD_LIMIT_BYTES) {
      return fail(
        `The Hikyaku ${name} for checkout is too large (${Buffer.byteLength(value)} bytes, the limit is ${FUNCTION_METAFIELD_LIMIT_BYTES}). Offer fewer services or bands.`,
      );
    }
  }

  const locations = await mappedLocations(access, shop);
  if (!locations.ok) return fail(locations.error);

  let profiles: CurrentProfile[];
  try {
    profiles = await listDeliveryProfiles(admin);
  } catch (error) {
    return fail(`Couldn't read the shipping profiles (${message(error)}).`);
  }
  let mutations = await applyUpdates(
    admin,
    planProfileUpdates(
      profiles,
      locations.locations,
      desiredMethods(plan.data),
    ),
    errors,
  );

  // The Function goes on only after the rates exist, and is told about them.
  const metafields = [
    {
      namespace: FUNCTION_METAFIELD_NAMESPACE,
      key: "coverage",
      type: "json" as const,
      value: coverage,
    },
    {
      namespace: FUNCTION_METAFIELD_NAMESPACE,
      key: "rates",
      type: "json" as const,
      value: rates,
    },
  ];
  let customizationId: string | null = null;
  try {
    const existing = await findOwnCustomization(admin, shop);
    if (!existing) {
      const created = await createDeliveryCustomization(admin, {
        functionHandle: FUNCTION_HANDLE,
        title: CUSTOMIZATION_TITLE,
        enabled: true,
        metafields,
      });
      mutations++;
      if (created.ok) customizationId = created.data.id;
      else
        errors.push(
          `Couldn't turn on Hikyaku's checkout filter: ${created.errors.join("; ")}`,
        );
    } else {
      customizationId = existing.id;
      if (
        !existing.enabled ||
        !sameJson(existing.coverage, coverage) ||
        !sameJson(existing.rates, rates)
      ) {
        const updated = await updateDeliveryCustomization(admin, existing.id, {
          enabled: true,
          metafields,
        });
        mutations++;
        if (!updated.ok) {
          errors.push(
            `Couldn't update Hikyaku's checkout filter: ${updated.errors.join("; ")}`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(
      `Couldn't set up Hikyaku's checkout filter (${message(error)}).`,
    );
  }

  await prisma.shippingRates.upsert({
    where: { shop },
    create: {
      shop,
      deliveryCustomizationId: customizationId,
      staticRates: staticRateCodes(plan.data),
      error: errors.length > 0 ? errors.join(" ") : null,
    },
    update: {
      ...(customizationId ? { deliveryCustomizationId: customizationId } : {}),
      staticRates: staticRateCodes(plan.data),
      error: errors.length > 0 ? errors.join(" ") : null,
    },
  });

  return {
    ok: errors.length === 0,
    mutations,
    bboxFallback: plan.data.bbox_fallback,
    errors,
  };
}

/**
 * Removes everything the static path put in the shop: the Hikyaku method
 * definitions, the zones the app created, and the delivery customization
 * (its metafields go with it). Needed before uninstalling: afterwards the
 * app has no token, and without the Function the rates would show
 * everywhere in their zones.
 */
export async function removeStaticRates(
  admin: AdminApiContext,
  shop: string,
): Promise<StaticSyncResult> {
  const errors: string[] = [];
  let mutations = 0;

  // Rates first, then the Function: a removal that fails halfway leaves
  // Hikyaku rates still filtered, never showing everywhere in their zones.
  try {
    const profiles = await listDeliveryProfiles(admin);
    mutations += await applyUpdates(
      admin,
      planProfileUpdates(profiles, [], []),
      errors,
    );
  } catch (error) {
    errors.push(`Couldn't read the shipping profiles (${message(error)}).`);
  }

  if (errors.length === 0) {
    try {
      const existing = await findOwnCustomization(admin, shop);
      if (existing) {
        const deleted = await deleteDeliveryCustomization(admin, existing.id);
        mutations++;
        if (!deleted.ok) {
          errors.push(
            `Couldn't remove Hikyaku's checkout filter: ${deleted.errors.join("; ")}`,
          );
        }
      }
    } catch (error) {
      errors.push(
        `Couldn't remove Hikyaku's checkout filter (${message(error)}).`,
      );
    }
  }

  if (errors.length === 0) {
    await prisma.shippingRates.updateMany({
      where: { shop },
      data: {
        deliveryCustomizationId: null,
        staticRates: Prisma.DbNull,
        error: null,
      },
    });
  } else {
    await recordError(shop, errors.join(" "));
  }
  return { ok: errors.length === 0, mutations, bboxFallback: false, errors };
}

async function recordError(shop: string, error: string) {
  await prisma.shippingRates.updateMany({ where: { shop }, data: { error } });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
