// Turns an order's Shopify fulfillment orders into the `fulfillment_groups` of
// an order event: which location ships which line items. Pure, no I/O, so it
// is unit tested; the Admin API read lives in shopify-admin.server.ts.

import type { ShopifyFulfillmentOrder } from "./shopify-admin.server";

export type FulfillmentDeliveryMethod =
  "shipping" | "local" | "pickup" | "none";

export interface OrderFulfillmentGroup {
  /** The fulfillment order GID, e.g. `gid://shopify/FulfillmentOrder/1`. */
  id: string;
  /** The assigned location GID, as sent to PUT /integrations/locations. */
  external_location_id: string;
  external_location_name: string | null;
  delivery_method: FulfillmentDeliveryMethod;
  line_items: Array<{ line_item_id: string; quantity: number }>;
  total_weight_grams: number | null;
}

export type FulfillmentGroupsResult =
  | {
      ok: true;
      groups: OrderFulfillmentGroup[];
      /** Fulfillment orders left out because nothing is left to deliver. */
      skipped: Array<{ id: string; status: string }>;
      /** Line items Shopify routed that the order payload doesn't list. */
      unknownLineItemIds: string[];
    }
  | { ok: false; reason: string };

// Statuses whose location is settled and whose items still need to leave it.
// IN_PROGRESS is a partly fulfilled order, so only the remaining units count.
// ON_HOLD keeps its location while the merchant pauses it (fraud review, an
// address to confirm); dropping it would lose the delivery for good, as
// nothing tells Hikyaku when the hold is released.
const DELIVERABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS", "ON_HOLD"]);

// Statuses with nothing for Hikyaku to deliver now. CLOSED was fulfilled
// already (or closed by the merchant), CANCELLED was cancelled or replaced,
// INCOMPLETE is a fulfillment service giving up on a request. SCHEDULED is a
// fulfillment order held until its fulfill-at date, such as the later
// deliveries of a prepaid subscription: sending it would dispatch them all at
// once.
const SKIPPED_STATUSES = new Set([
  "CLOSED",
  "CANCELLED",
  "INCOMPLETE",
  "SCHEDULED",
]);

const DELIVERY_METHODS: Record<string, FulfillmentDeliveryMethod> = {
  SHIPPING: "shipping",
  LOCAL: "local",
  PICK_UP: "pickup",
};

const GRAMS_PER_UNIT: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

/** Shopify's DeliveryMethodType as the contract's delivery method. */
export function deliveryMethod(
  methodType: string | null | undefined,
): FulfillmentDeliveryMethod {
  return (methodType && DELIVERY_METHODS[methodType]) || "none";
}

/** A Shopify Weight in grams, or null for a unit this doesn't know. */
export function weightInGrams(weight: {
  value: number;
  unit: string;
}): number | null {
  const factor = GRAMS_PER_UNIT[weight.unit];
  return factor === undefined ? null : weight.value * factor;
}

/**
 * The numeric id at the end of a GID (`gid://shopify/LineItem/123` gives
 * `123`), which is how order events name line items. Anything else is
 * returned unchanged.
 */
export function legacyId(gid: string): string {
  const match = /^gid:\/\/shopify\/\w+\/(\d+)(?:\?.*)?$/.exec(gid);
  return match ? match[1] : gid;
}

/**
 * Maps fulfillment orders to fulfillment groups. Fails when routing isn't
 * settled yet: no fulfillment orders at all, a deliverable one without a
 * location, or a status this doesn't know. The caller should retry later
 * rather than send the order without groups, which Hikyaku would dispatch
 * from its nearest warehouse instead.
 *
 * @param orderLineItemIds The `order.line_items[].id` values of the event.
 * Line items outside it are left out of the groups (and reported), since the
 * API rejects a group naming a line item the order doesn't have. Null for an
 * event that carries no line items (order.fulfillment_updated), which keeps
 * every line item.
 */
export function buildFulfillmentGroups(
  fulfillmentOrders: ShopifyFulfillmentOrder[],
  orderLineItemIds: Iterable<string> | null,
): FulfillmentGroupsResult {
  if (fulfillmentOrders.length === 0) {
    return { ok: false, reason: "the order has no fulfillment orders yet" };
  }

  const known = orderLineItemIds ? new Set(orderLineItemIds) : null;
  const groups: OrderFulfillmentGroup[] = [];
  const skipped: Array<{ id: string; status: string }> = [];
  const unknownLineItemIds = new Set<string>();

  for (const fulfillmentOrder of fulfillmentOrders) {
    const { id, status } = fulfillmentOrder;
    if (SKIPPED_STATUSES.has(status)) {
      skipped.push({ id, status });
      continue;
    }
    if (!DELIVERABLE_STATUSES.has(status)) {
      return {
        ok: false,
        reason: `fulfillment order ${id} has status ${status}`,
      };
    }
    const location = fulfillmentOrder.assignedLocation.location;
    if (!location) {
      return {
        ok: false,
        reason: `fulfillment order ${id} has no assigned location`,
      };
    }

    const lineItems: OrderFulfillmentGroup["line_items"] = [];
    let weightGrams: number | null = 0;
    for (const item of fulfillmentOrder.lineItems) {
      const quantity = item.remainingQuantity;
      if (quantity < 1) continue;
      const lineItemId = legacyId(item.lineItem.id);
      if (known && !known.has(lineItemId)) {
        unknownLineItemIds.add(lineItemId);
        continue;
      }
      lineItems.push({ line_item_id: lineItemId, quantity });
      // One line without a weight makes the whole group's weight unknown:
      // a partial sum would understate it.
      const unitGrams = item.weight ? weightInGrams(item.weight) : null;
      weightGrams =
        weightGrams === null || unitGrams === null
          ? null
          : weightGrams + unitGrams * quantity;
    }
    if (lineItems.length === 0) {
      skipped.push({ id, status });
      continue;
    }

    groups.push({
      id,
      external_location_id: location.id,
      external_location_name: fulfillmentOrder.assignedLocation.name || null,
      delivery_method: deliveryMethod(
        fulfillmentOrder.deliveryMethod?.methodType,
      ),
      line_items: lineItems,
      total_weight_grams: weightGrams === null ? null : Math.round(weightGrams),
    });
  }

  return {
    ok: true,
    groups,
    skipped,
    unknownLineItemIds: [...unknownLineItemIds],
  };
}
