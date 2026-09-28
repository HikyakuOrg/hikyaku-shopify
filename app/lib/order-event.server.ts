// Transforms Shopify's REST-shaped orders/paid webhook payload into the JSON
// contract documented in docs/BACKEND_HANDOFF.md. Pure function, no I/O — the
// one piece of this app worth unit testing once the contract settles.

import type { OrderFulfillmentGroup } from "./fulfillment-groups";

interface ShopifyLineItem {
  id: number;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  price: string;
  grams: number;
  requires_shipping: boolean;
}

interface ShopifyAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  province_code: string | null;
  zip: string | null;
  country: string | null;
  country_code: string | null;
  company: string | null;
  name: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface ShopifyShippingLine {
  title: string;
  price: string;
}

interface ShopifyCustomer {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

// The subset of Shopify's orders/paid REST webhook payload this app reads.
// Every other field Shopify sends is ignored.
export interface ShopifyOrderPaidPayload {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  created_at: string;
  processed_at: string | null;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  total_price: string;
  subtotal_price: string | null;
  total_tax: string | null;
  total_weight: number | null;
  note: string | null;
  tags: string;
  line_items: ShopifyLineItem[];
  shipping_lines: ShopifyShippingLine[];
  shipping_address: ShopifyAddress | null;
  customer: ShopifyCustomer | null;
}

export interface OrderPaidEvent {
  event: {
    id: string;
    type: "order.paid";
    occurred_at: string;
    api_version: string;
  };
  source: {
    platform: "shopify";
    shop_domain: string;
    app_version: string;
  };
  order: {
    id: string;
    legacy_id: number;
    name: string;
    created_at: string;
    processed_at: string | null;
    currency: string;
    financial_status: string | null;
    fulfillment_status: string | null;
    total_price: string;
    subtotal_price: string | null;
    total_shipping: string;
    total_tax: string | null;
    note: string | null;
    tags: string[];
    total_weight_grams: number | null;
    line_items: Array<{
      id: string;
      title: string;
      variant_title: string | null;
      sku: string | null;
      quantity: number;
      price: string;
      grams: number;
      requires_shipping: boolean;
    }>;
  };
  customer: {
    id: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  };
  delivery: {
    required: boolean;
    recipient_name: string | null;
    phone: string | null;
    email: string | null;
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      province: string | null;
      province_code: string | null;
      postcode: string | null;
      country: string | null;
      country_code: string | null;
      company: string | null;
    } | null;
    latitude: number | null;
    longitude: number | null;
    shipping_method: string | null;
    instructions: string | null;
  };
  /**
   * Which location ships which line items. Always sent, and never empty:
   * without groups Hikyaku dispatches the whole order from its nearest
   * warehouse.
   */
  fulfillment_groups: OrderFulfillmentGroup[];
}

/**
 * The order's items were re-routed after orders/paid (a fulfillment order was
 * moved, split, merged or cancelled). Refers to the order by id only: Hikyaku
 * takes the recipient and line items from the order.paid it already has.
 */
export interface OrderFulfillmentUpdatedEvent {
  event: {
    id: string;
    type: "order.fulfillment_updated";
    occurred_at: string;
    api_version: string;
  };
  source: OrderPaidEvent["source"];
  order: { id: string; name: string | null };
  /**
   * Every group still to be delivered now, not just the changed ones. May be
   * empty, when nothing is left.
   */
  fulfillment_groups: OrderFulfillmentGroup[];
  /**
   * The fulfillment orders the change took items away from (the one moved
   * out of, those merged, the one cancelled). Hikyaku drops the package of
   * any that isn't in `fulfillment_groups` any more. A fulfillment order
   * that's simply gone from the groups without being released (fulfilled)
   * keeps its package.
   */
  released_group_ids: string[];
}

export type OrderEvent = OrderPaidEvent | OrderFulfillmentUpdatedEvent;

const APP_VERSION = "0.1.0";

export function buildOrderFulfillmentUpdatedEvent(params: {
  shop: string;
  webhookId: string;
  apiVersion: string;
  order: { id: string; name: string | null };
  /** From buildFulfillmentGroups, over the order's fulfillment orders now. */
  fulfillmentGroups: OrderFulfillmentGroup[];
  releasedGroupIds: string[];
  /** When the fulfillment orders were read. */
  occurredAt: Date;
}): OrderFulfillmentUpdatedEvent {
  return {
    event: {
      id: params.webhookId,
      type: "order.fulfillment_updated",
      occurred_at: params.occurredAt.toISOString(),
      api_version: params.apiVersion,
    },
    source: {
      platform: "shopify",
      shop_domain: params.shop,
      app_version: APP_VERSION,
    },
    order: params.order,
    fulfillment_groups: params.fulfillmentGroups,
    released_group_ids: params.releasedGroupIds,
  };
}

export function buildOrderPaidEvent(params: {
  shop: string;
  webhookId: string;
  apiVersion: string;
  payload: ShopifyOrderPaidPayload;
  /** From buildFulfillmentGroups, over the order's fulfillment orders. */
  fulfillmentGroups: OrderFulfillmentGroup[];
}): OrderPaidEvent {
  const { shop, webhookId, apiVersion, payload, fulfillmentGroups } = params;
  const { shipping_address: address, customer } = payload;

  const requiresShipping = payload.line_items.some(
    (item) => item.requires_shipping,
  );

  return {
    event: {
      id: webhookId,
      type: "order.paid",
      occurred_at: payload.processed_at ?? payload.created_at,
      api_version: apiVersion,
    },
    source: {
      platform: "shopify",
      shop_domain: shop,
      app_version: APP_VERSION,
    },
    order: {
      id: payload.admin_graphql_api_id,
      legacy_id: payload.id,
      name: payload.name,
      created_at: payload.created_at,
      processed_at: payload.processed_at,
      currency: payload.currency,
      financial_status: payload.financial_status,
      fulfillment_status: payload.fulfillment_status,
      total_price: payload.total_price,
      subtotal_price: payload.subtotal_price,
      total_shipping: sumShippingLines(payload.shipping_lines),
      total_tax: payload.total_tax,
      note: payload.note,
      tags: payload.tags
        ? payload.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [],
      total_weight_grams: payload.total_weight,
      line_items: payload.line_items.map((item) => ({
        id: lineItemId(item),
        title: item.title,
        variant_title: item.variant_title,
        sku: item.sku,
        quantity: item.quantity,
        price: item.price,
        grams: item.grams,
        requires_shipping: item.requires_shipping,
      })),
    },
    customer: {
      id: customer ? String(customer.id) : null,
      first_name: customer?.first_name ?? null,
      last_name: customer?.last_name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    },
    delivery: {
      // Shopify has no single "this order needs delivery" flag — the closest
      // signal is a shipping address plus at least one shippable line item.
      required: requiresShipping && address !== null,
      recipient_name: address?.name ?? null,
      phone: address?.phone ?? customer?.phone ?? null,
      email: customer?.email ?? null,
      address: address
        ? {
            line1: address.address1,
            line2: address.address2,
            city: address.city,
            province: address.province,
            province_code: address.province_code,
            postcode: address.zip,
            country: address.country,
            country_code: address.country_code,
            company: address.company,
          }
        : null,
      // Shopify essentially never geocodes shipping addresses — this is
      // almost always null. Geocoding is the backend's job; see the handoff
      // doc.
      latitude: address?.latitude ?? null,
      longitude: address?.longitude ?? null,
      shipping_method: payload.shipping_lines[0]?.title ?? null,
      instructions: payload.note,
    },
    fulfillment_groups: fulfillmentGroups,
  };
}

/**
 * The event's id for a payload line item: its numeric id as a string. A
 * fulfillment group names line items the same way, so a group's
 * `line_item_id` must match one of these exactly.
 */
export function lineItemId(item: Pick<ShopifyLineItem, "id">): string {
  return String(item.id);
}

function sumShippingLines(lines: ShopifyShippingLine[]): string {
  const total = lines.reduce((sum, line) => sum + (Number(line.price) || 0), 0);
  return total.toFixed(2);
}
