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

const APP_INSTALLATION_QUERY = `#graphql
  query HikyakuAppInstallation {
    currentAppInstallation {
      id
    }
  }
`;

/**
 * Whether the app is installed on the shop right now, for an app/uninstalled
 * delivery that may be a retry arriving after a reinstall. Uninstalling
 * revokes the shop's tokens, so this is false when there's no offline
 * session, its refresh fails, or the query fails.
 */
export async function isAppInstalled(
  shop: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const admin = await adminForShop(shop);
    await query(admin, APP_INSTALLATION_QUERY, {}, signal);
    return true;
  } catch {
    return false;
  }
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

/** A row of the Orders screen: enough to recognise the order. */
export interface ShopifyOrderSummary {
  /** GID, e.g. `gid://shopify/Order/123`. */
  id: string;
  name: string;
  processedAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: { displayName: string } | null;
  shippingAddress: {
    name: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCodeV2: string | null;
  } | null;
}

export interface OrderPage {
  orders: ShopifyOrderSummary[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

const ORDERS_QUERY = `#graphql
  query HikyakuOrders(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $query: String!
  ) {
    orders(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $query
      sortKey: PROCESSED_AT
      reverse: true
    ) {
      nodes {
        id
        name
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          displayName
        }
        shippingAddress {
          name
          city
          provinceCode
          countryCodeV2
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }`;

/**
 * One page of the orders matching an `orders` search, newest first. Shopify
 * only shows apps the last 60 days of orders without `read_all_orders`.
 * Scope: `read_orders`.
 *
 * @param page `after` for the next page, `before` for the previous one.
 */
export async function listOrders(
  admin: AdminApiContext,
  search: string,
  page: { size: number; after?: string | null; before?: string | null },
): Promise<OrderPage> {
  const backwards = !page.after && !!page.before;
  const data: {
    orders: {
      nodes: ShopifyOrderSummary[];
      pageInfo: OrderPage["pageInfo"];
    };
  } = await query(admin, ORDERS_QUERY, {
    query: search,
    first: backwards ? null : page.size,
    last: backwards ? page.size : null,
    after: backwards ? null : (page.after ?? null),
    before: backwards ? page.before : null,
  });
  return { orders: data.orders.nodes, pageInfo: data.orders.pageInfo };
}

interface Money {
  shopMoney: { amount: string };
}

export interface ShopifyOrderLineItem {
  /** GID, e.g. `gid://shopify/LineItem/123`. */
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  requiresShipping: boolean;
  originalUnitPriceSet: Money;
}

/**
 * A whole order as the Admin API has it, to send to Hikyaku as if its
 * orders/paid had arrived. See order-import.ts for the mapping.
 */
export interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt: string;
  currencyCode: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  cancelledAt: string | null;
  closed: boolean;
  totalPriceSet: Money;
  subtotalPriceSet: Money | null;
  totalTaxSet: Money | null;
  /** Grams, as a string (UnsignedInt64). */
  totalWeight: string | null;
  note: string | null;
  tags: string[];
  email: string | null;
  customer: {
    legacyResourceId: string;
    firstName: string | null;
    lastName: string | null;
    defaultEmailAddress: { emailAddress: string | null } | null;
    defaultPhoneNumber: { phoneNumber: string } | null;
  } | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCodeV2: string | null;
    company: string | null;
    name: string | null;
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  shippingLines: { nodes: Array<{ title: string; originalPriceSet: Money }> };
  lineItems: ShopifyOrderLineItem[];
}

const ORDER_LINE_ITEM_PAGE_SIZE = 100;

const ORDER_LINE_ITEMS_FIELDS = `
  nodes {
    id
    title
    variantTitle
    sku
    quantity
    requiresShipping
    originalUnitPriceSet {
      shopMoney {
        amount
      }
    }
  }
  pageInfo {
    hasNextPage
    endCursor
  }`;

const ORDER_QUERY = `#graphql
  query HikyakuOrder($id: ID!, $lineItemsFirst: Int!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      processedAt
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      cancelledAt
      closed
      totalPriceSet {
        shopMoney {
          amount
        }
      }
      subtotalPriceSet {
        shopMoney {
          amount
        }
      }
      totalTaxSet {
        shopMoney {
          amount
        }
      }
      totalWeight
      note
      tags
      email
      customer {
        legacyResourceId
        firstName
        lastName
        defaultEmailAddress {
          emailAddress
        }
        defaultPhoneNumber {
          phoneNumber
        }
      }
      shippingAddress {
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
        company
        name
        phone
        latitude
        longitude
      }
      shippingLines(first: 10) {
        nodes {
          title
          originalPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
      lineItems(first: $lineItemsFirst) {${ORDER_LINE_ITEMS_FIELDS}
      }
    }
  }`;

// Only for an order with more line items than fit on the first page above.
const ORDER_LINE_ITEMS_QUERY = `#graphql
  query HikyakuOrderLineItems($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {${ORDER_LINE_ITEMS_FIELDS}
      }
    }
  }`;

/**
 * An order with its customer, shipping address and every line item, for
 * sending an order placed before the store was connected. Returns null if
 * the order doesn't exist. Scope: `read_orders`.
 */
export async function getOrder(
  admin: AdminApiContext,
  orderId: string,
): Promise<ShopifyOrder | null> {
  const data: {
    order:
      | (Omit<ShopifyOrder, "lineItems"> & {
          lineItems: Connection<ShopifyOrderLineItem>;
        })
      | null;
  } = await query(admin, ORDER_QUERY, {
    id: orderId,
    lineItemsFirst: ORDER_LINE_ITEM_PAGE_SIZE,
  });
  if (!data.order) return null;

  const { lineItems: firstPage, ...order } = data.order;
  const lineItems = [...firstPage.nodes];
  let after = firstPage.pageInfo.hasNextPage
    ? firstPage.pageInfo.endCursor
    : null;
  while (after) {
    const page: {
      order: { lineItems: Connection<ShopifyOrderLineItem> } | null;
    } = await query(admin, ORDER_LINE_ITEMS_QUERY, {
      id: orderId,
      first: PAGE_SIZE,
      after,
    });
    if (!page.order) return null;
    lineItems.push(...page.order.lineItems.nodes);
    after = page.order.lineItems.pageInfo.hasNextPage
      ? page.order.lineItems.pageInfo.endCursor
      : null;
  }
  return { ...order, lineItems };
}
