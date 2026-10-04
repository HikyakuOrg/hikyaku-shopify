import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  redirect,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fetchIntegrationLocations,
  fetchWarehouses,
  describeFailure,
  hikyakuAccess,
  upsertIntegrationLocations,
  type HikyakuResult,
} from "../lib/hikyaku-api.server";
import {
  listLocations,
  type ShopifyLocation,
} from "../lib/shopify-admin.server";
import {
  mappingValue,
  needsMapping,
  parseMappingValue,
  suggestWarehouse,
  syncInput,
  warehouseValue,
  type HikyakuWarehouse,
  type IntegrationLocation,
  type IntegrationLocationInput,
} from "../lib/location-mapping";
import {
  LocationMappingForm,
  SAVED_FIELD_PREFIX,
  VALUE_FIELD_PREFIX,
  type LocationMappingData,
  type LocationRow,
} from "../components/location-mapping-form";

type LoaderData =
  | ({ status: "ready" } & LocationMappingData)
  | { status: "error"; message: string };

type ActionData = { ok: true; saved: number } | { error: string };

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string | null): string {
  if (!code) return "Country not set";
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

function addressLine(address: ShopifyLocation["address"]): string {
  return [
    address.address1,
    address.address2,
    address.city,
    address.province ?? address.provinceCode,
    address.zip,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");
}

function buildRow(
  location: ShopifyLocation,
  saved: IntegrationLocation | undefined,
  warehouses: HikyakuWarehouse[],
  { suggest }: { suggest: boolean },
): LocationRow {
  const mode = saved?.mode ?? "unmapped";
  const savedValue = mappingValue(mode, saved?.warehouse_id ?? null);

  // Only a location still waiting for a decision gets a suggestion, and it
  // stays a suggestion (preselected, badged) until the merchant saves.
  const suggestion =
    suggest && mode === "unmapped"
      ? suggestWarehouse(location, warehouses)
      : null;
  const suggested = suggestion
    ? warehouses.find((warehouse) => warehouse.id === suggestion.warehouseId)
    : undefined;

  return {
    id: location.id,
    name: location.name,
    address: addressLine(location.address),
    country: countryName(location.address.countryCode),
    value: suggested ? warehouseValue(suggested.id) : savedValue,
    savedValue,
    suggestion:
      suggestion && suggested
        ? { warehouseName: suggested.name, distanceKm: suggestion.distanceKm }
        : null,
    note: needsMapping(location)
      ? undefined
      : location.isActive
        ? "Doesn't fulfil online orders"
        : "Inactive",
  };
}

// Every load re-lists the shop's locations and upserts them without a mode:
// new locations arrive `unmapped`, renamed ones get their new name, the
// merchant's choices stay, and locations gone from Shopify are marked stale.
// An account that can't write gets the same screen read-only (syncOrRead).
export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) throw redirect("/app");
  const { accessToken, organisationSlug } = hikyaku;

  let locations: ShopifyLocation[];
  let warehousesResult: HikyakuResult<HikyakuWarehouse[]>;
  try {
    [locations, warehousesResult] = await Promise.all([
      listLocations(admin),
      fetchWarehouses(accessToken, organisationSlug),
    ]);
  } catch (error) {
    // listLocations is the only one that throws, e.g. before the merchant
    // has granted read_locations.
    console.error(`Couldn't list Shopify locations for ${shop}`, error);
    return {
      status: "error",
      message: "Couldn't read this store's locations from Shopify.",
    };
  }
  if (!warehousesResult.ok) {
    return {
      status: "error",
      message: describeFailure(warehousesResult, "list warehouses"),
    };
  }
  const warehouses = warehousesResult.data;

  const stored = await syncOrRead(
    accessToken,
    organisationSlug,
    shop,
    locations,
  );
  if (!stored.ok) {
    return { status: "error", message: stored.message };
  }
  const saved = new Map(
    stored.rows.map((row) => [row.external_location_id, row] as const),
  );

  const rows: LocationRow[] = [];
  const otherRows: LocationRow[] = [];
  for (const location of locations) {
    const mappable = needsMapping(location);
    const row = buildRow(location, saved.get(location.id), warehouses, {
      suggest: mappable,
    });
    (mappable ? rows : otherRows).push(row);
  }

  return {
    status: "ready",
    rows,
    otherRows,
    warehouses: warehouses.map(({ id, name }) => ({ id, name })),
    readOnly: stored.readOnly ? { email: hikyaku.email } : null,
  };
}

type StoredLocations =
  | { ok: true; rows: IntegrationLocation[]; readOnly: boolean }
  | { ok: false; message: string };

// Syncing needs integrations.locations.write, reading only warehouse.view. The
// API has no way to ask which permissions the caller holds, so the sync itself
// is the check: a 403 means the account can't write, and the screen falls back
// to reading what Hikyaku has stored, read-only. The warehouses call has
// already passed the membership and trial checks, so a 403 here can only be
// the missing write permission. The refused PUT writes nothing.
async function syncOrRead(
  accessToken: string,
  organisationSlug: string,
  shop: string,
  locations: ShopifyLocation[],
): Promise<StoredLocations> {
  const synced = await upsertIntegrationLocations(
    accessToken,
    organisationSlug,
    shop,
    locations.map(syncInput),
    { markMissingStale: true },
  );
  if (synced.ok) return { ok: true, rows: synced.data, readOnly: false };
  if (synced.status !== 403) {
    return {
      ok: false,
      message: describeFailure(synced, "update this store's locations"),
    };
  }

  const read = await fetchIntegrationLocations(
    accessToken,
    organisationSlug,
    shop,
  );
  if (!read.ok) {
    return {
      ok: false,
      message: describeFailure(read, "read this store's locations"),
    };
  }
  return { ok: true, rows: read.data, readOnly: true };
}

// Sends only the locations whose picker differs from what Hikyaku has saved,
// with an explicit mode. Accepting a suggestion is one of those changes.
export async function action({
  request,
}: ActionFunctionArgs): Promise<ActionData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) {
    return { error: "This store isn't connected to Hikyaku any more." };
  }

  const formData = await request.formData();
  // Re-list rather than trust the form for anything but the choice itself,
  // and to send the current name and country along with it.
  const locations = new Map(
    (await listLocations(admin)).map((location) => [location.id, location]),
  );

  const changes: IntegrationLocationInput[] = [];
  for (const [key, value] of formData) {
    if (typeof value !== "string" || !key.startsWith(VALUE_FIELD_PREFIX)) {
      continue;
    }
    const id = key.slice(VALUE_FIELD_PREFIX.length);
    const location = locations.get(id);
    // Deleted in Shopify since the page loaded; the next sync marks it stale.
    if (!location) continue;
    if (value === formData.get(SAVED_FIELD_PREFIX + id)) continue;
    const choice = parseMappingValue(value);
    if (!choice) return { error: `Unrecognised choice for ${location.name}.` };
    changes.push({
      ...syncInput(location),
      mode: choice.mode,
      warehouse_id: choice.warehouseId,
    });
  }

  if (changes.length === 0) return { ok: true, saved: 0 };

  const result = await upsertIntegrationLocations(
    hikyaku.accessToken,
    hikyaku.organisationSlug,
    shop,
    changes,
  );
  if (!result.ok) {
    return {
      error:
        result.status === 404
          ? "One of the chosen warehouses no longer exists in Hikyaku. Reload the page and pick again."
          : describeFailure(result, "save location mappings"),
    };
  }
  return { ok: true, saved: changes.length };
}

export default function Locations() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  // Set when the merchant arrived here from picking their organisation:
  // choosing which earlier orders to send comes next.
  const [searchParams] = useSearchParams();
  const settingUp = searchParams.has("setup");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data) {
      shopify.toast.show(
        fetcher.data.saved === 0 ? "Nothing to save" : "Locations saved",
      );
      if (settingUp) navigate("/app/orders");
    }
  }, [fetcher.state, fetcher.data, shopify, settingUp, navigate]);

  return (
    <s-page heading="Locations">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      {data.status === "error" ? (
        <s-banner heading="Couldn't load locations" tone="critical">
          {data.message}
        </s-banner>
      ) : (
        <LocationMappingForm
          data={data}
          Form={fetcher.Form}
          busy={fetcher.state !== "idle"}
          error={
            fetcher.data && "error" in fetcher.data
              ? fetcher.data.error
              : undefined
          }
        />
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
