import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  toGrams,
  type CurrentLocationGroup,
  type CurrentMethod,
  type CurrentProfile,
  type CurrentZone,
  type ProfileInput,
} from "./static-rates";

// The app's Admin API calls. Every query and mutation here needs a scope
// listed in shopify.app.toml, and AGENTS.md lists each one with the reason it
// exists; keep all three in sync when adding one.

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
        name
        shippingLines(first: 5) {
          nodes {
            title
            code
          }
        }${FULFILLMENT_ORDERS_FIELDS}
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
  /** The order's shipping lines: which rate the shopper chose. */
  shippingLines: Array<{ title: string; code: string | null }>;
  /** All of that order's fulfillment orders, as getOrderFulfillmentOrders. */
  fulfillmentOrders: ShopifyFulfillmentOrder[];
}

/**
 * The order a fulfillment order belongs to, with its shipping lines and all of
 * its fulfillment orders. Returns null if the fulfillment order doesn't exist.
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
        shippingLines: { nodes: ShopifyOrderFulfillment["shippingLines"] };
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
  const { id, name, shippingLines, fulfillmentOrders } =
    data.fulfillmentOrder.order;
  const all = await collectFulfillmentOrders(
    admin,
    id,
    fulfillmentOrders,
    options.signal,
  );
  return (
    all && {
      order: { id, name },
      shippingLines: shippingLines.nodes,
      fulfillmentOrders: all,
    }
  );
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

/** A carrier service as the app reads it back. */
export interface ShopifyCarrierService {
  /** GID, e.g. `gid://shopify/DeliveryCarrierService/123`. */
  id: string;
  name: string | null;
  callbackUrl: string | null;
  active: boolean;
}

/** A mutation's `userErrors`, flattened to messages. */
export type MutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: string[] };

const CARRIER_SERVICE_FIELDS = `
  id
  name
  callbackUrl
  active`;

const CARRIER_SERVICES_QUERY = `#graphql
  query HikyakuCarrierServices($first: Int!, $after: String) {
    carrierServices(first: $first, after: $after) {
      nodes {${CARRIER_SERVICE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

/**
 * The shop's carrier services, to find the app's own again. Scope:
 * `read_shipping` (implied by `write_shipping`).
 */
export async function listCarrierServices(
  admin: AdminApiContext,
): Promise<ShopifyCarrierService[]> {
  const services: ShopifyCarrierService[] = [];
  let after: string | null = null;
  do {
    const data: { carrierServices: Connection<ShopifyCarrierService> } =
      await query(admin, CARRIER_SERVICES_QUERY, { first: PAGE_SIZE, after });
    services.push(...data.carrierServices.nodes);
    after = data.carrierServices.pageInfo.hasNextPage
      ? data.carrierServices.pageInfo.endCursor
      : null;
  } while (after);
  return services;
}

const CARRIER_SERVICE_QUERY = `#graphql
  query HikyakuCarrierService($id: ID!) {
    carrierService(id: $id) {${CARRIER_SERVICE_FIELDS}
    }
  }`;

/** One carrier service by GID, or null if it's gone. Scope: `read_shipping`. */
export async function getCarrierService(
  admin: AdminApiContext,
  id: string,
): Promise<ShopifyCarrierService | null> {
  const data: { carrierService: ShopifyCarrierService | null } = await query(
    admin,
    CARRIER_SERVICE_QUERY,
    { id },
  );
  return data.carrierService;
}

interface UserError {
  field: string[] | null;
  message: string;
}

function mutationResult<T>(
  payload: { userErrors: UserError[] } & Record<string, unknown>,
  value: T | null | undefined,
): MutationResult<T> {
  if (payload.userErrors.length > 0) {
    return {
      ok: false,
      errors: payload.userErrors.map((error) => error.message),
    };
  }
  if (value === null || value === undefined) {
    return { ok: false, errors: ["Shopify returned no result"] };
  }
  return { ok: true, data: value };
}

const CARRIER_SERVICE_CREATE_MUTATION = `#graphql
  mutation HikyakuCarrierServiceCreate(
    $input: DeliveryCarrierServiceCreateInput!
  ) {
    carrierServiceCreate(input: $input) {
      carrierService {${CARRIER_SERVICE_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }`;

export interface CarrierServiceInput {
  name: string;
  callbackUrl: string;
  active: boolean;
}

/**
 * Registers a carrier service whose callback Shopify calls at checkout.
 * Shopify refuses it (userErrors) on a plan without third-party
 * carrier-calculated shipping. Scope: `write_shipping`.
 */
export async function createCarrierService(
  admin: AdminApiContext,
  input: CarrierServiceInput,
): Promise<MutationResult<ShopifyCarrierService>> {
  const data: {
    carrierServiceCreate: {
      carrierService: ShopifyCarrierService | null;
      userErrors: UserError[];
    };
  } = await query(admin, CARRIER_SERVICE_CREATE_MUTATION, {
    input: { ...input, supportsServiceDiscovery: true },
  });
  return mutationResult(
    data.carrierServiceCreate,
    data.carrierServiceCreate.carrierService,
  );
}

const CARRIER_SERVICE_UPDATE_MUTATION = `#graphql
  mutation HikyakuCarrierServiceUpdate(
    $input: DeliveryCarrierServiceUpdateInput!
  ) {
    carrierServiceUpdate(input: $input) {
      carrierService {${CARRIER_SERVICE_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }`;

/** Changes a carrier service's name, callback or `active`. Scope: `write_shipping`. */
export async function updateCarrierService(
  admin: AdminApiContext,
  id: string,
  input: Partial<CarrierServiceInput>,
): Promise<MutationResult<ShopifyCarrierService>> {
  const data: {
    carrierServiceUpdate: {
      carrierService: ShopifyCarrierService | null;
      userErrors: UserError[];
    };
  } = await query(admin, CARRIER_SERVICE_UPDATE_MUTATION, {
    input: { id, ...input },
  });
  return mutationResult(
    data.carrierServiceUpdate,
    data.carrierServiceUpdate.carrierService,
  );
}

const CARRIER_SERVICE_DELETE_MUTATION = `#graphql
  mutation HikyakuCarrierServiceDelete($id: ID!) {
    carrierServiceDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }`;

/** Removes a carrier service. Scope: `write_shipping`. */
export async function deleteCarrierService(
  admin: AdminApiContext,
  id: string,
): Promise<MutationResult<string>> {
  const data: {
    carrierServiceDelete: { deletedId: string | null; userErrors: UserError[] };
  } = await query(admin, CARRIER_SERVICE_DELETE_MUTATION, { id });
  return mutationResult(
    data.carrierServiceDelete,
    data.carrierServiceDelete.deletedId,
  );
}

// Delivery profiles: the static path of Hikyaku rates (HIK-216) writes its
// method definitions into the merchant's own profiles. See static-rates.ts.

const DELIVERY_PROFILES_QUERY = `#graphql
  query HikyakuDeliveryProfiles($first: Int!, $after: String) {
    deliveryProfiles(first: $first, after: $after, merchantOwnedOnly: true) {
      nodes {
        id
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

const DELIVERY_PROFILE_GROUPS_QUERY = `#graphql
  query HikyakuDeliveryProfileGroups($id: ID!) {
    deliveryProfile(id: $id) {
      profileLocationGroups {
        locationGroup {
          id
          locations(first: 250, includeInactive: true) {
            nodes {
              id
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }`;

// Zones come a few at a time: each carries up to 100 method definitions, and
// Shopify rejects a query costing over 1000 points.
const ZONE_PAGE_SIZE = 5;
const METHOD_PAGE_SIZE = 100;

const DELIVERY_GROUP_ZONES_QUERY = `#graphql
  query HikyakuDeliveryGroupZones(
    $id: ID!
    $groupId: ID!
    $first: Int!
    $after: String
    $methodsFirst: Int!
  ) {
    deliveryProfile(id: $id) {
      profileLocationGroups(locationGroupId: $groupId) {
        locationGroupZones(first: $first, after: $after) {
          nodes {
            zone {
              id
              name
              countries {
                code {
                  countryCode
                  restOfWorld
                }
              }
            }
            methodDefinitions(first: $methodsFirst, type: MERCHANT) {
              nodes {
                id
                name
                description
                active
                rateProvider {
                  ... on DeliveryRateDefinition {
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
                methodConditions {
                  field
                  operator
                  conditionCriteria {
                    ... on Weight {
                      unit
                      value
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }`;

interface RawMethodDefinition {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  rateProvider: { price?: { amount: string; currencyCode: string } };
  methodConditions: Array<{
    field: string;
    operator: string;
    conditionCriteria: { unit?: string; value?: number };
  }>;
}

interface RawGroupZone {
  zone: {
    id: string;
    name: string;
    countries: Array<{
      code: { countryCode: string | null; restOfWorld: boolean };
    }>;
  };
  methodDefinitions: {
    nodes: RawMethodDefinition[];
    pageInfo: { hasNextPage: boolean };
  };
}

function currentMethod(raw: RawMethodDefinition): CurrentMethod {
  let weight: CurrentMethod["weight"] = null;
  for (const condition of raw.methodConditions) {
    const { unit, value } = condition.conditionCriteria;
    if (condition.field !== "TOTAL_WEIGHT" || !unit || value === undefined) {
      continue;
    }
    weight ??= { min: null, max: null };
    const grams = Math.round(toGrams(value, unit) * 1000) / 1000;
    if (condition.operator === "GREATER_THAN_OR_EQUAL_TO") weight.min = grams;
    else weight.max = grams;
  }
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    active: raw.active,
    price: raw.rateProvider.price ?? null,
    weight,
  };
}

/**
 * The merchant's delivery profiles with, per location group, its locations
 * and zones (countries and merchant method definitions). Scope:
 * `read_shipping` (implied by `write_shipping`).
 */
export async function listDeliveryProfiles(
  admin: AdminApiContext,
): Promise<CurrentProfile[]> {
  const summaries: Array<{ id: string; name: string }> = [];
  let after: string | null = null;
  do {
    const data: {
      deliveryProfiles: Connection<{ id: string; name: string }>;
    } = await query(admin, DELIVERY_PROFILES_QUERY, { first: 50, after });
    summaries.push(...data.deliveryProfiles.nodes);
    after = data.deliveryProfiles.pageInfo.hasNextPage
      ? data.deliveryProfiles.pageInfo.endCursor
      : null;
  } while (after);

  const profiles: CurrentProfile[] = [];
  for (const summary of summaries) {
    const data: {
      deliveryProfile: {
        profileLocationGroups: Array<{
          locationGroup: { id: string; locations: Connection<{ id: string }> };
        }>;
      } | null;
    } = await query(admin, DELIVERY_PROFILE_GROUPS_QUERY, { id: summary.id });
    if (!data.deliveryProfile) continue;

    const groups: CurrentLocationGroup[] = [];
    for (const { locationGroup } of data.deliveryProfile
      .profileLocationGroups) {
      if (locationGroup.locations.pageInfo.hasNextPage) {
        console.warn(
          `Delivery location group ${locationGroup.id} has more than 250 locations; only the first 250 are considered`,
        );
      }
      groups.push({
        id: locationGroup.id,
        locationIds: locationGroup.locations.nodes.map((node) => node.id),
        zones: await listGroupZones(admin, summary.id, locationGroup.id),
      });
    }
    profiles.push({ id: summary.id, name: summary.name, groups });
  }
  return profiles;
}

async function listGroupZones(
  admin: AdminApiContext,
  profileId: string,
  groupId: string,
): Promise<CurrentZone[]> {
  const zones: CurrentZone[] = [];
  let after: string | null = null;
  do {
    const data: {
      deliveryProfile: {
        profileLocationGroups: Array<{
          locationGroupZones: Connection<RawGroupZone>;
        }>;
      } | null;
    } = await query(admin, DELIVERY_GROUP_ZONES_QUERY, {
      id: profileId,
      groupId,
      first: ZONE_PAGE_SIZE,
      after,
      methodsFirst: METHOD_PAGE_SIZE,
    });
    const page =
      data.deliveryProfile?.profileLocationGroups[0]?.locationGroupZones;
    if (!page) break;
    for (const node of page.nodes) {
      if (node.methodDefinitions.pageInfo.hasNextPage) {
        console.warn(
          `Delivery zone ${node.zone.id} has more than ${METHOD_PAGE_SIZE} method definitions; only the first ${METHOD_PAGE_SIZE} are considered`,
        );
      }
      zones.push({
        id: node.zone.id,
        name: node.zone.name,
        countries: node.zone.countries.map((country) => ({
          code: country.code.countryCode,
          restOfWorld: country.code.restOfWorld,
        })),
        methods: node.methodDefinitions.nodes.map(currentMethod),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return zones;
}

const DELIVERY_PROFILE_UPDATE_MUTATION = `#graphql
  mutation HikyakuDeliveryProfileUpdate(
    $id: ID!
    $profile: DeliveryProfileInput!
  ) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Applies one delivery profile's changes from planProfileUpdates. Scope:
 * `write_shipping`.
 */
export async function updateDeliveryProfile(
  admin: AdminApiContext,
  id: string,
  profile: ProfileInput,
): Promise<MutationResult<string>> {
  const data: {
    deliveryProfileUpdate: {
      profile: { id: string } | null;
      userErrors: UserError[];
    };
  } = await query(admin, DELIVERY_PROFILE_UPDATE_MUTATION, { id, profile });
  return mutationResult(
    data.deliveryProfileUpdate,
    data.deliveryProfileUpdate.profile?.id,
  );
}

/** A delivery customization, with the app's metafields the Function reads. */
export interface ShopifyDeliveryCustomization {
  id: string;
  title: string;
  enabled: boolean;
  functionId: string;
  coverage: { value: string } | null;
  rates: { value: string } | null;
}

/** Where the Function's settings live on its delivery customization. */
export const FUNCTION_METAFIELD_NAMESPACE = "$app:hikyaku";

const DELIVERY_CUSTOMIZATION_FIELDS = `
  id
  title
  enabled
  functionId
  coverage: metafield(namespace: "${FUNCTION_METAFIELD_NAMESPACE}", key: "coverage") {
    value
  }
  rates: metafield(namespace: "${FUNCTION_METAFIELD_NAMESPACE}", key: "rates") {
    value
  }`;

const DELIVERY_CUSTOMIZATIONS_QUERY = `#graphql
  query HikyakuDeliveryCustomizations($first: Int!, $after: String) {
    deliveryCustomizations(first: $first, after: $after) {
      nodes {${DELIVERY_CUSTOMIZATION_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

/**
 * The shop's delivery customizations, to find the app's own again. Scope:
 * `read_delivery_customizations` (implied by `write_delivery_customizations`).
 */
export async function listDeliveryCustomizations(
  admin: AdminApiContext,
): Promise<ShopifyDeliveryCustomization[]> {
  const customizations: ShopifyDeliveryCustomization[] = [];
  let after: string | null = null;
  do {
    const data: {
      deliveryCustomizations: Connection<ShopifyDeliveryCustomization>;
    } = await query(admin, DELIVERY_CUSTOMIZATIONS_QUERY, {
      first: 50,
      after,
    });
    customizations.push(...data.deliveryCustomizations.nodes);
    after = data.deliveryCustomizations.pageInfo.hasNextPage
      ? data.deliveryCustomizations.pageInfo.endCursor
      : null;
  } while (after);
  return customizations;
}

const DELIVERY_CUSTOMIZATION_CREATE_MUTATION = `#graphql
  mutation HikyakuDeliveryCustomizationCreate(
    $input: DeliveryCustomizationInput!
  ) {
    deliveryCustomizationCreate(deliveryCustomization: $input) {
      deliveryCustomization {${DELIVERY_CUSTOMIZATION_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }`;

export interface DeliveryCustomizationInput {
  functionHandle?: string;
  title?: string;
  enabled?: boolean;
  metafields?: Array<{
    namespace: string;
    key: string;
    type: "json";
    value: string;
  }>;
}

/**
 * Activates the app's delivery customization Function for the shop. Scope:
 * `write_delivery_customizations`.
 */
export async function createDeliveryCustomization(
  admin: AdminApiContext,
  input: DeliveryCustomizationInput,
): Promise<MutationResult<ShopifyDeliveryCustomization>> {
  const data: {
    deliveryCustomizationCreate: {
      deliveryCustomization: ShopifyDeliveryCustomization | null;
      userErrors: UserError[];
    };
  } = await query(admin, DELIVERY_CUSTOMIZATION_CREATE_MUTATION, { input });
  return mutationResult(
    data.deliveryCustomizationCreate,
    data.deliveryCustomizationCreate.deliveryCustomization,
  );
}

const DELIVERY_CUSTOMIZATION_UPDATE_MUTATION = `#graphql
  mutation HikyakuDeliveryCustomizationUpdate(
    $id: ID!
    $input: DeliveryCustomizationInput!
  ) {
    deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
      deliveryCustomization {${DELIVERY_CUSTOMIZATION_FIELDS}
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Changes the delivery customization (enabled, its metafields). Scope:
 * `write_delivery_customizations`.
 */
export async function updateDeliveryCustomization(
  admin: AdminApiContext,
  id: string,
  input: DeliveryCustomizationInput,
): Promise<MutationResult<ShopifyDeliveryCustomization>> {
  const data: {
    deliveryCustomizationUpdate: {
      deliveryCustomization: ShopifyDeliveryCustomization | null;
      userErrors: UserError[];
    };
  } = await query(admin, DELIVERY_CUSTOMIZATION_UPDATE_MUTATION, {
    id,
    input,
  });
  return mutationResult(
    data.deliveryCustomizationUpdate,
    data.deliveryCustomizationUpdate.deliveryCustomization,
  );
}

const DELIVERY_CUSTOMIZATION_DELETE_MUTATION = `#graphql
  mutation HikyakuDeliveryCustomizationDelete($id: ID!) {
    deliveryCustomizationDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Removes the delivery customization, and with it its metafields. Scope:
 * `write_delivery_customizations`.
 */
export async function deleteDeliveryCustomization(
  admin: AdminApiContext,
  id: string,
): Promise<MutationResult<string>> {
  const data: {
    deliveryCustomizationDelete: {
      deletedId: string | null;
      userErrors: UserError[];
    };
  } = await query(admin, DELIVERY_CUSTOMIZATION_DELETE_MUTATION, { id });
  return mutationResult(
    data.deliveryCustomizationDelete,
    data.deliveryCustomizationDelete.deletedId,
  );
}
