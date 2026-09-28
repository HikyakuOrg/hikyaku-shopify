import type { ElementType, ReactNode } from "react";
import {
  NOT_DELIVERED_VALUE,
  UNMAPPED_VALUE,
  parseMappingValue,
  warehouseValue,
} from "../lib/location-mapping";

export interface LocationRow {
  /** Shopify location GID. */
  id: string;
  name: string;
  address: string;
  country: string;
  /** Picker value to show: the suggestion if there is one, else what is saved. */
  value: string;
  /** Picker value of what Hikyaku has saved, so a save only sends changes. */
  savedValue: string;
  suggestion: { warehouseName: string; distanceKm: number } | null;
  /** Why a location is in "Other locations". */
  note?: string;
}

export interface WarehouseOption {
  id: string;
  name: string;
}

export interface LocationMappingData {
  /** Active locations that fulfil online orders: the ones to decide on. */
  rows: LocationRow[];
  /** Inactive locations and ones that don't fulfil online orders. */
  otherRows: LocationRow[];
  warehouses: WarehouseOption[];
}

/** Form field names; the action reads them back with these prefixes. */
export const VALUE_FIELD_PREFIX = "location:";
export const SAVED_FIELD_PREFIX = "saved:";

const kilometres = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  style: "unit",
  unit: "kilometer",
});

function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return kilometres.format(km);
}

// s-select ignores a `value` attribute set before its options exist, as on
// first render, and falls back to the first option. So the initial choice is
// marked on the option itself, and the attribute is left off entirely
// otherwise: React 18 would write selected="false", which still counts.
function Option({
  value,
  current,
  children,
}: {
  value: string;
  current: string;
  children: ReactNode;
}) {
  return (
    <s-option value={value} {...(value === current ? { selected: true } : {})}>
      {children}
    </s-option>
  );
}

function isMissingWarehouse(value: string, warehouses: WarehouseOption[]) {
  return (
    parseMappingValue(value)?.mode === "warehouse" &&
    !warehouses.some((warehouse) => warehouseValue(warehouse.id) === value)
  );
}

/**
 * The location rows of the mapping form: one picker per location, named so
 * the enclosing form posts `location:<gid>` (the choice) and `saved:<gid>`
 * (what was saved before) for each.
 */
export function LocationMappingTable({
  rows,
  warehouses,
}: {
  rows: LocationRow[];
  warehouses: WarehouseOption[];
}) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Location</s-table-header>
        <s-table-header>Ships from</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.id}>
            <s-table-cell>
              <s-stack gap="small-500">
                <s-text type="strong">{row.name}</s-text>
                {row.address && <s-text color="subdued">{row.address}</s-text>}
                <s-text color="subdued">{row.country}</s-text>
                {row.note && <s-text color="subdued">{row.note}</s-text>}
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              <s-stack gap="small-300">
                <s-select
                  label={`Where ${row.name} ships from`}
                  labelAccessibilityVisibility="exclusive"
                  name={VALUE_FIELD_PREFIX + row.id}
                  value={row.value}
                >
                  <Option value={UNMAPPED_VALUE} current={row.value}>
                    Not mapped yet
                  </Option>
                  {warehouses.map((warehouse) => (
                    <Option
                      key={warehouse.id}
                      value={warehouseValue(warehouse.id)}
                      current={row.value}
                    >
                      {warehouse.name}
                    </Option>
                  ))}
                  {isMissingWarehouse(row.value, warehouses) && (
                    // Keeps a saved warehouse the list no longer has from
                    // silently turning into "Not mapped yet" on the next save.
                    <Option value={row.value} current={row.value}>
                      Warehouse no longer listed
                    </Option>
                  )}
                  <Option value={NOT_DELIVERED_VALUE} current={row.value}>
                    Not delivered by Hikyaku
                  </Option>
                </s-select>
                {row.suggestion && (
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-badge tone="info">Suggested</s-badge>
                    <s-text color="subdued">
                      {row.suggestion.warehouseName} is{" "}
                      {formatDistance(row.suggestion.distanceKm)} away. Save to
                      confirm.
                    </s-text>
                  </s-stack>
                )}
              </s-stack>
              <input
                type="hidden"
                name={SAVED_FIELD_PREFIX + row.id}
                value={row.savedValue}
              />
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

/**
 * The location mapping page body. Kept apart from the route's loader and
 * fetcher so it only depends on its props.
 */
export function LocationMappingForm({
  data,
  Form,
  busy,
  error,
}: {
  data: LocationMappingData;
  /** A fetcher's Form in the app; any form element works. */
  Form: ElementType;
  busy: boolean;
  error?: string;
}) {
  return (
    <Form method="post">
      {error && (
        <s-banner heading="Couldn't save" tone="critical">
          {error}
        </s-banner>
      )}
      <s-section heading="Where each location ships from">
        <s-paragraph>
          Pick the Hikyaku warehouse that delivers the orders each location
          fulfils, or mark the location as not delivered by Hikyaku. Orders from
          a location that isn&apos;t mapped need attention in Hikyaku.
        </s-paragraph>
        {data.warehouses.length === 0 && (
          <s-banner tone="warning">
            Your Hikyaku organisation has no warehouses yet. Add one in Hikyaku
            to deliver from it, then reload this page.
          </s-banner>
        )}
        {data.rows.length === 0 ? (
          <s-paragraph>
            No active locations fulfil online orders on this store.
          </s-paragraph>
        ) : (
          <LocationMappingTable rows={data.rows} warehouses={data.warehouses} />
        )}
      </s-section>

      {data.otherRows.length > 0 && (
        <s-section heading="Other locations">
          <details>
            <summary>
              {data.otherRows.length === 1
                ? "1 location is inactive or doesn't fulfil online orders"
                : `${data.otherRows.length} locations are inactive or don't fulfil online orders`}
            </summary>
            <s-box paddingBlockStart="base">
              <LocationMappingTable
                rows={data.otherRows}
                warehouses={data.warehouses}
              />
            </s-box>
          </details>
        </s-section>
      )}

      <s-stack direction="inline" justifyContent="end" paddingBlock="base">
        <s-button
          type="submit"
          variant="primary"
          {...(busy ? { loading: true } : {})}
        >
          Save
        </s-button>
      </s-stack>
    </Form>
  );
}
