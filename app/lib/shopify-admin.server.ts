import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate, unauthenticated } from "../shopify.server";

// The app's only Admin API reads. Every query here needs a scope listed in
// shopify.app.toml, and AGENTS.md lists each one with the reason it exists;
// keep all three in sync when adding a query.

/** Admin client for an embedded admin request (a loader or action under /app). */
export async function adminForRequest(
  request: Request,
): Promise<AdminApiContext> {
  const { admin } = await authenticate.admin(request);
  return admin;
}

/**
 * Admin client backed by the shop's offline session, for webhook handlers and
 * other work with no merchant in the admin. Throws `SessionNotFoundError` if
 * the shop has no offline session (e.g. after app/uninstalled).
 */
export async function adminForShop(shop: string): Promise<AdminApiContext> {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

// admin.graphql throws GraphqlQueryError when the response carries errors, so
// only a missing `data` is left to check here.
async function query<T>(
  admin: AdminApiContext,
  operation: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await admin.graphql(operation, { variables, signal });
  const body = (await response.json()) as { data?: T };
  if (!body.data) {
    throw new Error("Shopify Admin API returned no data");
  }
  return body.data;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const PAGE_SIZE = 250;

export interface ShopifyLocation {
  /** GID, e.g. `gid://shopify/Location/123`. */
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
  };
}

const LOCATIONS_QUERY = `#graphql
  query HikyakuLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
        address {
          address1
          address2
          city
          province
          provinceCode
          zip
          countryCode
          latitude
          longitude
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

/**
 * Every location in the shop, deactivated ones included, so a merchant can
 * map each to a Hikyaku depot. Scope: `read_locations`.
 */
export async function listLocations(
  admin: AdminApiContext,
): Promise<ShopifyLocation[]> {
  const locations: ShopifyLocation[] = [];
  let after: string | null = null;
  do {
    const data: { locations: Connection<ShopifyLocation> } = await query(
      admin,
      LOCATIONS_QUERY,
      { first: PAGE_SIZE, after },
    );
    locations.push(...data.locations.nodes);
    after = data.locations.pageInfo.hasNextPage
      ? data.locations.pageInfo.endCursor
      : null;
  } while (after);
  return locations;
}

export interface ShopifyFulfillmentOrderLineItem {
  id: string;
  totalQuantity: number;
  remainingQuantity: number;
  /** The order line item this fulfillment order line item draws from. */
  lineItem: { id: string };
  /** Weight of one unit. Null when Shopify has none for the variant. */
  weight: { value: number; unit: string } | null;
}

export interface ShopifyFulfillmentOrder {
  /** GID, e.g. `gid://shopify/FulfillmentOrder/123`. */
  id: string;
  /** FulfillmentOrderStatus, e.g. OPEN, IN_PROGRESS, CLOSED, CANCELLED. */
  status: string;
  assignedLocation: {
    name: string;
    /** Null when the location has since been deleted. */
    location: { id: string } | null;
  };
  /** DeliveryMethodType, e.g. SHIPPING, LOCAL, PICK_UP. */
  deliveryMethod: { methodType: string } | null;
  lineItems: ShopifyFulfillmentOrderLineItem[];
}

// Nested connections multiply query cost, and Shopify rejects any single
// query above 1000 points, so these pages are much smaller than 250.
const FULFILLMENT_ORDER_PAGE_SIZE = 10;
const FULFILLMENT_ORDER_LINE_ITEM_PAGE_SIZE = 40;

const LINE_ITEM_FIELDS = `
  nodes {
    id
    totalQuantity
    remainingQuantity
    lineItem {
      id
    }
    weight {
      value
      unit
    }
  }
  pageInfo {
    hasNextPage
    endCursor
  }`;

// No `destination`: the delivery address already arrives in orders/paid, so
// there is no reason to read it again from here.
const FULFILLMENT_ORDERS_FIELDS = `
  fulfillmentOrders(first: $first, after: $after) {
    nodes {
      id
      status
      assignedLocation {
        name
        location {
          id
        }
      }
      deliveryMethod {
        methodType
      }
      lineItems(first: $lineItemsFirst) {${LINE_ITEM_FIELDS}
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }`;

const ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query HikyakuOrderFulfillmentOrders(
    $id: ID!
    $first: Int!
    $after: String
    $lineItemsFirst: Int!
  ) {
    order(id: $id) {${FULFILLMENT_ORDERS_FIELDS}
    }
  }`;

// The fulfillment_orders/* webhooks name fulfillment orders, not the order,
// so this finds the order and its first page of fulfillment orders in one go.
const FULFILLMENT_ORDER_ORDER_QUERY = `#graphql
  query HikyakuFulfillmentOrderOrder(
    $fulfillmentOrderId: ID!
    $first: Int!
    $after: String
    $lineItemsFirst: Int!
  ) {
    fulfillmentOrder(id: $fulfillmentOrderId) {
      order {
        id
        name${FULFILLMENT_ORDERS_FIELDS}
      }
    }
  }`;

// Only for the rare fulfillment order with more line items than fit on the
// first page above.
const FULFILLMENT_ORDER_LINE_ITEMS_QUERY = `#graphql
  query HikyakuFulfillmentOrderLineItems(
    $id: ID!
    $first: Int!
    $after: String
  ) {
    fulfillmentOrder(id: $id) {
      lineItems(first: $first, after: $after) {${LINE_ITEM_FIELDS}
      }
    }
  }`;

type RawFulfillmentOrder = Omit<ShopifyFulfillmentOrder, "lineItems"> & {
  lineItems: Connection<ShopifyFulfillmentOrderLineItem>;
};

/**
 * The merchant managed fulfillment orders of an order: which location ships
 * which line items. Returns null if the order doesn't exist. Scopes:
 * `read_orders` + `read_merchant_managed_fulfillment_orders`.
 *
 * @param orderId Order GID (the `admin_graphql_api_id` of orders/paid).
 * @param options.signal Aborts every page request, e.g. to fit a webhook's
 * time budget.
 */
export async function getOrderFulfillmentOrders(
  admin: AdminApiContext,
  orderId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ShopifyFulfillmentOrder[] | null> {
  return collectFulfillmentOrders(admin, orderId, null, options.signal);
}

export interface ShopifyOrderFulfillment {
  /** The order the fulfillment order belongs to. */
  order: { id: string; name: string };
  /** All of that order's fulfillment orders, as getOrderFulfillmentOrders. */
  fulfillmentOrders: ShopifyFulfillmentOrder[];
}

/**
 * The order a fulfillment order belongs to, with all of the order's
 * fulfillment orders. Returns null if the fulfillment order doesn't exist.
 * Scopes: `read_orders` + `read_merchant_managed_fulfillment_orders`.
 *
 * @param fulfillmentOrderId FulfillmentOrder GID, as the fulfillment_orders/*
 * webhooks name it.
 * @param options.signal Aborts every page request.
 */
export async function getFulfillmentOrderOrder(
  admin: AdminApiContext,
  fulfillmentOrderId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ShopifyOrderFulfillment | null> {
  const data: {
    fulfillmentOrder: {
      order: {
        id: string;
        name: string;
        fulfillmentOrders: Connection<RawFulfillmentOrder>;
      };
    } | null;
  } = await query(
    admin,
    FULFILLMENT_ORDER_ORDER_QUERY,
    {
      fulfillmentOrderId,
      first: FULFILLMENT_ORDER_PAGE_SIZE,
      after: null,
      lineItemsFirst: FULFILLMENT_ORDER_LINE_ITEM_PAGE_SIZE,
    },
    options.signal,
  );
  if (!data.fulfillmentOrder) return null;
  const { id, name, fulfillmentOrders } = data.fulfillmentOrder.order;
  const all = await collectFulfillmentOrders(
    admin,
    id,
    fulfillmentOrders,
    options.signal,
  );
  return all && { order: { id, name }, fulfillmentOrders: all };
}

/**
 * Walks an order's fulfillment orders page by page, starting from
 * `firstPage` when the caller already has it. Null if the order is gone.
 */
async function collectFulfillmentOrders(
  admin: AdminApiContext,
  orderId: string,
  firstPage: Connection<RawFulfillmentOrder> | null,
  signal?: AbortSignal,
): Promise<ShopifyFulfillmentOrder[] | null> {
  const fulfillmentOrders: ShopifyFulfillmentOrder[] = [];
  let page = firstPage;
  let after: string | null = null;
  do {
    if (!page) {
      const data: {
        order: { fulfillmentOrders: Connection<RawFulfillmentOrder> } | null;
      } = await query(
        admin,
        ORDER_FULFILLMENT_ORDERS_QUERY,
        {
          id: orderId,
          first: FULFILLMENT_ORDER_PAGE_SIZE,
          after,
          lineItemsFirst: FULFILLMENT_ORDER_LINE_ITEM_PAGE_SIZE,
        },
        signal,
      );
      if (!data.order) return null;
      page = data.order.fulfillmentOrders;
    }
    for (const node of page.nodes) {
      fulfillmentOrders.push({
        ...node,
        lineItems: await remainingLineItems(
          admin,
          node.id,
          node.lineItems,
          signal,
        ),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    page = null;
  } while (after);
  return fulfillmentOrders;
}

async function remainingLineItems(
  admin: AdminApiContext,
  fulfillmentOrderId: string,
  firstPage: Connection<ShopifyFulfillmentOrderLineItem>,
  signal?: AbortSignal,
): Promise<ShopifyFulfillmentOrderLineItem[]> {
  const lineItems = [...firstPage.nodes];
  let after = firstPage.pageInfo.hasNextPage
    ? firstPage.pageInfo.endCursor
    : null;
  while (after) {
    const data: {
      fulfillmentOrder: {
        lineItems: Connection<ShopifyFulfillmentOrderLineItem>;
      } | null;
    } = await query(
      admin,
      FULFILLMENT_ORDER_LINE_ITEMS_QUERY,
      { id: fulfillmentOrderId, first: PAGE_SIZE, after },
      signal,
    );
    if (!data.fulfillmentOrder) break;
    const page = data.fulfillmentOrder.lineItems;
    lineItems.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
  return lineItems;
}
