import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  describeFailure,
  fetchShippingRates,
  fetchStaticPlan,
  hikyakuAccess,
  saveShippingRates,
  type ShippingRateService,
  type ShippingRateSettings,
} from "../lib/hikyaku-api.server";
import { getShopInfo } from "../lib/shopify-admin.server";
import { capabilityFromPlan, type RatePath } from "../lib/rate-path";
import {
  applyRates,
  reconcileRates,
  type ApplyRatesResult,
} from "../lib/rates-setup.server";
import {
  SERVICE_FIELD,
  bandMaxField,
  bandUnit,
  bandWidthField,
  defaultBand,
  describeSettingsError,
  formatRate,
  parseSettingsForm,
} from "../lib/shipping-rates-form";
import type { StaticPlanRate } from "../lib/static-rates";

// Hikyaku rates at checkout (HIK-206/HIK-211): which catalog services the
// shop offers, on or off, and on which path (live carrier service quotes, or
// fixed-price bands for plans without carrier-calculated shipping; see
// rates-setup.server.ts). Loading the screen re-checks a shop with rates on,
// switching path if its plan changed and retrying a failed setup.

/** Scopes added for Hikyaku rates; an older install may not have them yet. */
const RATE_SCOPES = ["write_shipping", "write_delivery_customizations"];

interface StaticPreview {
  rates: Array<
    Pick<StaticPlanRate, "code" | "service_name" | "kind" | "price"> & {
      label: string;
    }
  >;
  currency: string;
  bboxFallback: boolean;
}

type LoaderData =
  | { status: "disconnected" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      email: string;
      currency: string;
      missingScopes: string[];
      enabled: boolean;
      /** The path the shop is on, or would be on when rates go on. */
      path: RatePath | "probe";
      pathReason: string;
      /** The last setup's failure, still to be retried. */
      setupError: string | null;
      stripeConnected: boolean;
      services: ShippingRateService[];
      settings: ShippingRateSettings;
      dashboardServiceUrl: string | null;
      /** False when the account can only view (null: unknown until saving). */
      canEdit: boolean | null;
      staticPreview: StaticPreview | null;
    };

type ActionData =
  | { saved: true; result: ApplyRatesResult }
  | { removed: true; errors: string[] }
  | { error: string; readOnly?: boolean };

function bandLabel(rate: StaticPlanRate): string {
  if (rate.kind === "flat") return "Any distance";
  if (
    rate.unit &&
    typeof rate.band_min === "number" &&
    typeof rate.band_max === "number"
  ) {
    return `${rate.band_min}–${rate.band_max} ${rate.unit}`;
  }
  return rate.kind === "distance"
    ? `${rate.min_km ?? 0}–${rate.max_km ?? 0} km`
    : `${(rate.min_grams ?? 0) / 1000}–${(rate.max_grams ?? 0) / 1000} kg`;
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) return { status: "disconnected" };

  const granted = new Set((session.scope ?? "").split(","));
  const missingScopes = RATE_SCOPES.filter((scope) => !granted.has(scope));

  if (missingScopes.length === 0) {
    try {
      await reconcileRates(admin, shop);
    } catch (error) {
      console.error(`Re-checking Hikyaku rates failed for ${shop}`, error);
    }
  }

  let info;
  try {
    info = await getShopInfo(admin);
  } catch (error) {
    console.error(`Couldn't read the shop for ${shop}`, error);
    return {
      status: "error",
      message: "Couldn't read this store from Shopify.",
    };
  }

  const overview = await fetchShippingRates(
    hikyaku.accessToken,
    hikyaku.organisationSlug,
    shop,
    info.currencyCode,
  );
  if (!overview.ok) {
    return {
      status: "error",
      message: describeFailure(overview, "read the Hikyaku rate settings"),
    };
  }

  const state = await prisma.shippingRates.findUnique({ where: { shop } });
  const capability = capabilityFromPlan(
    info.plan,
    process.env.HIKYAKU_RATES_PATH,
  );
  const enabled = state?.enabled ?? false;
  const path: RatePath | "probe" =
    enabled && state?.path ? (state.path as RatePath) : capability.path;
  const pathReason =
    enabled && state?.path === "static" && capability.path !== "static"
      ? `${capability.reason}, but Shopify didn't allow it for this store`
      : capability.reason;

  let staticPreview: StaticPreview | null = null;
  if (enabled && state?.path === "static") {
    const plan = await fetchStaticPlan(
      hikyaku.accessToken,
      hikyaku.organisationSlug,
      shop,
    );
    if (plan.ok) {
      staticPreview = {
        currency: plan.data.currency,
        bboxFallback: plan.data.bbox_fallback,
        rates: plan.data.rates.map((rate) => ({
          code: rate.code,
          service_name: rate.service_name,
          kind: rate.kind,
          price: rate.price,
          label: bandLabel(rate),
        })),
      };
    }
  }

  const data = overview.data as typeof overview.data & { can_edit?: boolean };
  return {
    status: "ready",
    email: hikyaku.email,
    currency: info.currencyCode,
    missingScopes,
    enabled,
    path,
    pathReason,
    setupError: state?.error ?? null,
    stripeConnected: data.stripe_connected,
    services: data.services,
    settings: data.settings,
    dashboardServiceUrl: data.dashboard_service_url,
    canEdit: typeof data.can_edit === "boolean" ? data.can_edit : null,
    staticPreview,
  };
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<ActionData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) {
    return { error: "This store isn't connected to Hikyaku any more." };
  }
  const form = await request.formData();
  const intent = form.get("intent");

  const info = await getShopInfo(admin);
  const overview = await fetchShippingRates(
    hikyaku.accessToken,
    hikyaku.organisationSlug,
    shop,
    info.currencyCode,
  );
  if (!overview.ok) {
    return {
      error: describeFailure(overview, "read the Hikyaku rate settings"),
    };
  }
  const { settings, services } = overview.data;

  if (intent === "remove") {
    // Shopify first: that's what shoppers see. hikyaku-api then stops
    // answering the callback too.
    const result = await applyRates(admin, shop, { enabled: false });
    const saved = await saveShippingRates(
      hikyaku.accessToken,
      hikyaku.organisationSlug,
      shop,
      { ...settings, enabled: false, shop_currency: info.currencyCode },
    );
    const errors = [...result.errors];
    if (!saved.ok && saved.status !== 403) {
      errors.push(describeSettingsError(saved, services, info.currencyCode));
    }
    return { removed: true, errors };
  }

  if (intent !== "save") return { error: "Unknown action." };

  const state = await prisma.shippingRates.findUnique({ where: { shop } });
  const capability = capabilityFromPlan(
    info.plan,
    process.env.HIKYAKU_RATES_PATH,
  );
  const path: RatePath =
    (state?.path as RatePath | null) ??
    (capability.path === "static" ? "static" : "live");
  const parsed = parseSettingsForm(form, services, {
    needsBands: path === "static",
  });
  if (!parsed.ok) return { error: parsed.error };

  const saved = await saveShippingRates(
    hikyaku.accessToken,
    hikyaku.organisationSlug,
    shop,
    {
      enabled: parsed.enabled,
      service_ids: parsed.serviceIds,
      band_settings: parsed.bandSettings,
      path,
      shop_currency: info.currencyCode,
    },
  );
  if (!saved.ok) {
    return {
      error: describeSettingsError(saved, services, info.currencyCode),
      ...(saved.status === 403 ? { readOnly: true } : {}),
    };
  }

  const result = await applyRates(admin, shop, { enabled: parsed.enabled });
  return { saved: true, result };
}

function PathExplanation({
  path,
  reason,
}: {
  path: RatePath | "probe";
  reason: string;
}) {
  if (path === "static") {
    return (
      <s-paragraph>
        <s-text type="strong">Fixed-price bands.</s-text> Shopify doesn&apos;t
        let this store ask for a quote at checkout ({reason}), so Hikyaku writes
        its rates into your shipping settings as price bands. Checkout shows the
        band for the straight-line distance from your nearest mapped warehouse,
        priced at the band&apos;s upper edge, and weight bands follow the
        cart&apos;s weight.
      </s-paragraph>
    );
  }
  return (
    <s-paragraph>
      <s-text type="strong">Live quotes.</s-text> Shopify asks Hikyaku for the
      price at each checkout: road distance from the warehouse the order ships
      from, and the cart&apos;s weight ({reason}
      {path === "probe" ? "; checked with Shopify when you turn rates on" : ""}
      ).
    </s-paragraph>
  );
}

export default function ShippingRates() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("saved" in fetcher.data && fetcher.data.result.ok) {
      shopify.toast.show(
        fetcher.data.result.enabled
          ? "Hikyaku rates saved"
          : "Hikyaku rates off",
      );
    }
    if ("removed" in fetcher.data && fetcher.data.errors.length === 0) {
      shopify.toast.show("Hikyaku rates removed");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  if (data.status === "disconnected") {
    return (
      <s-page heading="Shipping rates">
        <s-link slot="breadcrumb-actions" href="/app">
          Home
        </s-link>
        <s-banner heading="Connect Hikyaku first" tone="info">
          Hikyaku rates come from your Hikyaku organisation&apos;s services.{" "}
          <s-link href="/app">Connect Hikyaku</s-link> to set them up.
        </s-banner>
      </s-page>
    );
  }
  if (data.status === "error") {
    return (
      <s-page heading="Shipping rates">
        <s-link slot="breadcrumb-actions" href="/app">
          Home
        </s-link>
        <s-banner heading="Couldn't load shipping rates" tone="critical">
          {data.message}
        </s-banner>
      </s-page>
    );
  }

  const result =
    fetcher.data && "saved" in fetcher.data ? fetcher.data.result : null;
  const readOnly =
    data.canEdit === false ||
    (!!fetcher.data && "readOnly" in fetcher.data && !!fetcher.data.readOnly);
  const blocked = readOnly || data.missingScopes.length > 0;
  const showBands = data.path === "static";
  const chosen = new Set(data.settings.service_ids);

  return (
    <s-page heading="Shipping rates">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      {data.missingScopes.length > 0 && (
        <s-banner heading="Approve the new permissions" tone="warning">
          Hikyaku rates need permission to manage this store&apos;s shipping
          settings. Shopify asks you to approve the app&apos;s updated
          permissions when you next open it from your admin; until then rates
          can&apos;t be changed here.
        </s-banner>
      )}
      {readOnly && (
        <s-banner heading="View only" tone="info">
          The Hikyaku account connected to this store ({data.email}) can see
          these settings but isn&apos;t allowed to change them. Ask an admin of
          your Hikyaku organisation for permission to manage shipping rates,
          then reload this page.
        </s-banner>
      )}
      {fetcher.data && "error" in fetcher.data && (
        <s-banner heading="Couldn't save" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}
      {result && !result.ok && (
        <s-banner heading="Hikyaku rates aren't fully set up" tone="critical">
          {result.errors.join(" ")} This is retried when you reload this page.
        </s-banner>
      )}
      {!result && data.setupError && (
        <s-banner heading="Hikyaku rates need attention" tone="warning">
          {data.setupError} This is retried each time this page loads.
        </s-banner>
      )}
      {fetcher.data &&
        "removed" in fetcher.data &&
        fetcher.data.errors.length > 0 && (
          <s-banner
            heading="Some Hikyaku rates couldn't be removed"
            tone="critical"
          >
            {fetcher.data.errors.join(" ")}
          </s-banner>
        )}
      {!data.stripeConnected && (
        <s-banner heading="Connect Stripe in Hikyaku" tone="warning">
          Rates are priced from your Hikyaku service catalog, which needs Stripe
          connected to your Hikyaku organisation.
        </s-banner>
      )}
      {data.staticPreview?.bboxFallback && (
        <s-banner heading="Service areas are approximated" tone="warning">
          Some service areas are too detailed to check at checkout, so
          they&apos;re checked as their surrounding rectangle: addresses just
          outside an area can still be offered Hikyaku rates.
        </s-banner>
      )}

      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="save" />
        <s-section heading="Hikyaku rates at checkout">
          <s-stack gap="base">
            <s-paragraph>
              Offer your Hikyaku delivery services as shipping rates at
              checkout, priced in {data.currency} from your Hikyaku service
              catalog.
            </s-paragraph>
            <PathExplanation path={data.path} reason={data.pathReason} />
            <s-checkbox
              name="enabled"
              value="on"
              label="Offer Hikyaku rates at checkout"
              details="With rates on, only orders that chose a Hikyaku rate are sent to Hikyaku. Orders using your other rates aren't."
              {...(data.enabled ? { checked: true } : {})}
              {...(blocked ? { disabled: true } : {})}
            />
          </s-stack>
        </s-section>

        <s-section heading="Services">
          {data.services.length === 0 ? (
            <s-paragraph>
              Your Hikyaku organisation has no services yet. Add one in the
              Hikyaku dashboard, then reload this page.
            </s-paragraph>
          ) : (
            <s-stack gap="base">
              {data.services.map((service) => {
                const rate = formatRate(service);
                const unit = bandUnit(service.unit);
                const band =
                  data.settings.band_settings[service.id] ??
                  defaultBand(service.unit);
                return (
                  <s-stack key={service.id} gap="small-200">
                    <s-checkbox
                      name={SERVICE_FIELD}
                      value={service.id}
                      label={`${service.name}${rate ? ` · ${rate}` : ""}`}
                      details={
                        rate
                          ? (service.description ?? undefined)
                          : `No price in ${data.currency} yet.`
                      }
                      {...(chosen.has(service.id) && rate
                        ? { checked: true }
                        : {})}
                      {...(blocked || !rate ? { disabled: true } : {})}
                    />
                    {!rate && data.dashboardServiceUrl && (
                      <s-link href={data.dashboardServiceUrl} target="_blank">
                        Add a {data.currency} price in Hikyaku
                      </s-link>
                    )}
                    {showBands && unit && rate && (
                      <s-stack direction="inline" gap="base">
                        <s-number-field
                          name={bandWidthField(service.id)}
                          label={`Band size (${unit})`}
                          value={String(band.band_width)}
                          min={0}
                          step={0.5}
                          {...(blocked ? { disabled: true } : {})}
                        />
                        <s-number-field
                          name={bandMaxField(service.id)}
                          label={`Up to (${unit})`}
                          value={String(band.max)}
                          min={0}
                          step={0.5}
                          details={
                            unit === "kg" || unit === "lb"
                              ? "Heavier carts get no Hikyaku rate."
                              : "Further addresses get no Hikyaku rate."
                          }
                          {...(blocked ? { disabled: true } : {})}
                        />
                      </s-stack>
                    )}
                  </s-stack>
                );
              })}
            </s-stack>
          )}
          <s-stack direction="inline" justifyContent="end" paddingBlock="base">
            <s-button
              type="submit"
              variant="primary"
              {...(busy ? { loading: true } : {})}
              {...(blocked ? { disabled: true } : {})}
            >
              Save
            </s-button>
          </s-stack>
        </s-section>
      </fetcher.Form>

      {data.staticPreview && data.staticPreview.rates.length > 0 && (
        <s-section heading="Rates in your shipping settings">
          <s-paragraph>
            These are written into your shipping zones. Checkout shows the one
            that fits the address, named after its service.
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Service</s-table-header>
              <s-table-header>Band</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.staticPreview.rates.map((rate) => (
                <s-table-row key={rate.code}>
                  <s-table-cell>{rate.service_name}</s-table-cell>
                  <s-table-cell>{rate.label}</s-table-cell>
                  <s-table-cell>
                    {new Intl.NumberFormat("en", {
                      style: "currency",
                      currency: data.staticPreview!.currency,
                    }).format(Number(rate.price))}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      <s-section heading="Where Hikyaku rates show">
        <s-unordered-list>
          <s-list-item>
            Only where a driver covers the address: a Hikyaku rate shows for
            addresses inside the service areas of the warehouse the order ships
            from.
          </s-list-item>
          <s-list-item>
            Everywhere, when your organisation has no service areas, a driver at
            that warehouse has none, or service area matching is switched off.
          </s-list-item>
          <s-list-item>
            Never for items shipped from a location that isn&apos;t mapped to a
            Hikyaku warehouse.{" "}
            <s-link href="/app/locations">Map locations</s-link>
          </s-list-item>
          <s-list-item>
            Never for shoppers checking out in another currency than{" "}
            {data.currency}.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Remove Hikyaku rates">
        <s-paragraph>
          Takes every Hikyaku rate out of checkout and your shipping settings,
          and turns Hikyaku rates off. Use this{" "}
          <s-text type="strong">before uninstalling the app</s-text>: once
          it&apos;s uninstalled, Hikyaku can&apos;t remove the rates it wrote
          into your shipping settings, and they&apos;d show at checkout for
          every address.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="remove" />
          <s-stack direction="inline" justifyContent="end" paddingBlock="base">
            <s-button
              type="submit"
              tone="critical"
              {...(busy ? { loading: true } : {})}
              {...(data.missingScopes.length > 0 ? { disabled: true } : {})}
            >
              Remove Hikyaku rates
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
