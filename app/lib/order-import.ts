// Orders placed before the store was connected never reached Hikyaku, since
// orders/paid only fires once. The Orders screen lets the merchant pick some
// and sends each as the order.paid it would have been. This module is the
// pure part: which orders are offered, and the Admin API order turned into
// the orders/paid payload shape, so buildOrderPaidEvent stays the one place
// that knows the event contract.

import type { ShopifyOrderPaidPayload } from "./order-event.server";
import type {
  ShopifyFulfillmentOrder,
  ShopifyOrder,
} from "./shopify-admin.server";
import { weightInGrams } from "./fulfillment-groups";

/** The most orders one import sends, and the size of a page on the screen. */
export const ORDER_IMPORT_LIMIT = 50;

// Open (not archived or cancelled), paid, and with something still to ship:
// what orders/paid would have sent and Hikyaku could still deliver.
const IMPORTABLE_SEARCH = [
  "status:open",
  "financial_status:paid,partially_refunded",
  "fulfillment_status:unshipped,unfulfilled,partial,on_hold",
].join(" ");

/**
 * The `orders` search for orders that can be sent to Hikyaku, optionally only
 * those paid before `processedBefore` (when the store was connected, so the
 * orders/paid webhook never saw them).
 */
export function importableOrdersSearch(processedBefore?: Date): string {
  return processedBefore
    ? `${IMPORTABLE_SEARCH} processed_at:<'${processedBefore.toISOString()}'`
    : IMPORTABLE_SEARCH;
}

const IMPORTABLE_FINANCIAL_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED"]);

/**
 * Why an order can't be sent any more, or null if it can. The screen only
 * lists importable orders, but one may have been cancelled, archived or
 * refunded since it loaded.
 */
export function notImportableReason(
  order: Pick<
    ShopifyOrder,
    "cancelledAt" | "closed" | "displayFinancialStatus"
  >,
): string | null {
  if (order.cancelledAt) return "It has been cancelled.";
  if (order.closed) return "It has been archived.";
  if (!IMPORTABLE_FINANCIAL_STATUSES.has(order.displayFinancialStatus ?? "")) {
    return "It isn't paid.";
  }
  return null;
}

/**
 * The Idempotency-Key of an order's import. One per order, so sending the
 * same order twice (a double click, a second tab) records it once.
 */
export function importEventId(orderId: string): string {
  return `import:${orderId}`;
}

/** The numeric id at the end of a GID, e.g. `123` for `gid://shopify/LineItem/123`. */
function legacyId(gid: string): string {
  return gid.slice(gid.lastIndexOf("/") + 1);
}

// orders/paid's REST names for an order's display fulfillment status.
const FULFILLMENT_STATUSES: Record<string, string | null> = {
  UNFULFILLED: null,
  PARTIALLY_FULFILLED: "partial",
  FULFILLED: "fulfilled",
  RESTOCKED: "restocked",
};

function fulfillmentStatus(status: string): string | null {
  return status in FULFILLMENT_STATUSES
    ? FULFILLMENT_STATUSES[status]
    : status.toLowerCase();
}

/**
 * Unit weight in grams per order line item id, from the fulfillment orders:
 * the order's line items carry no weight the app's scopes can read.
 */
function gramsByLineItem(
  fulfillmentOrders: ShopifyFulfillmentOrder[],
): Map<string, number> {
  const grams = new Map<string, number>();
  for (const fulfillmentOrder of fulfillmentOrders) {
    for (const item of fulfillmentOrder.lineItems) {
      const weight = item.weight && weightInGrams(item.weight);
      if (weight != null && !grams.has(item.lineItem.id)) {
        grams.set(item.lineItem.id, Math.round(weight));
      }
    }
  }
  return grams;
}

/**
 * The Admin API order as the orders/paid payload Shopify would have sent.
 * Line item weights come from the fulfillment orders (0 when unknown, as in
 * the webhook).
 */
export function orderPaidPayloadFromOrder(
  order: ShopifyOrder,
  fulfillmentOrders: ShopifyFulfillmentOrder[],
): ShopifyOrderPaidPayload {
  const grams = gramsByLineItem(fulfillmentOrders);
  const { customer, shippingAddress: address } = order;
  return {
    id: Number(order.legacyResourceId),
    admin_graphql_api_id: order.id,
    name: order.name,
    created_at: order.createdAt,
    processed_at: order.processedAt,
    currency: order.currencyCode,
    financial_status: order.displayFinancialStatus?.toLowerCase() ?? null,
    fulfillment_status: fulfillmentStatus(order.displayFulfillmentStatus),
    total_price: order.totalPriceSet.shopMoney.amount,
    subtotal_price: order.subtotalPriceSet?.shopMoney.amount ?? null,
    total_tax: order.totalTaxSet?.shopMoney.amount ?? null,
    total_weight: order.totalWeight === null ? null : Number(order.totalWeight),
    note: order.note,
    tags: order.tags.join(", "),
    line_items: order.lineItems.map((item) => ({
      id: Number(legacyId(item.id)),
      title: item.title,
      variant_title: item.variantTitle,
      sku: item.sku,
      quantity: item.quantity,
      price: item.originalUnitPriceSet.shopMoney.amount,
      grams: grams.get(item.id) ?? 0,
      requires_shipping: item.requiresShipping,
    })),
    shipping_lines: order.shippingLines.nodes.map((line) => ({
      title: line.title,
      price: line.originalPriceSet.shopMoney.amount,
    })),
    shipping_address: address && {
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      province: address.province,
      province_code: address.provinceCode,
      zip: address.zip,
      country: address.country,
      country_code: address.countryCodeV2,
      company: address.company,
      name: address.name,
      phone: address.phone,
      latitude: address.latitude,
      longitude: address.longitude,
    },
    customer: customer && {
      id: Number(customer.legacyResourceId),
      first_name: customer.firstName,
      last_name: customer.lastName,
      email: customer.defaultEmailAddress?.emailAddress ?? order.email,
      phone: customer.defaultPhoneNumber?.phoneNumber ?? null,
    },
  };
}
