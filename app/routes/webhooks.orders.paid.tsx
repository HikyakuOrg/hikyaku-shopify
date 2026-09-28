import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getConnection,
  getValidAccessToken,
  postOrderEvent,
} from "../lib/hikyaku-api.server";
import {
  buildOrderPaidEvent,
  lineItemId,
  type ShopifyOrderPaidPayload,
} from "../lib/order-event.server";
import { buildFulfillmentGroups } from "../lib/fulfillment-groups";
import {
  adminForShop,
  getOrderFulfillmentOrders,
  type ShopifyFulfillmentOrder,
} from "../lib/shopify-admin.server";

// Of the 5 seconds Shopify allows, the POST to hikyaku-api takes up to 4, so
// the fulfillment order read gets about 1.
const FULFILLMENT_ORDERS_TIMEOUT_MS = 1000;

// The core integration. Response status is the reliability contract with
// Shopify's webhook retrier — see docs/BACKEND_HANDOFF.md and
// hikyaku-api.server.ts's postOrderEvent for the full mapping. Shopify gives
// us a 5-second budget end to end, so every branch here returns fast.
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const connection = await getConnection(shop);
  if (!connection || !connection.organisationSlug) {
    console.log(
      `Skipping orders/paid for ${shop}: not connected to Hikyaku yet`,
    );
    return new Response();
  }

  const accessToken = await getValidAccessToken(shop);
  if (!accessToken) {
    // Vanishingly rare — the connection was deleted between the two lookups
    // above (e.g. a concurrent "Disconnect" click).
    console.error(`Lost Hikyaku connection for ${shop} mid-request`);
    return new Response();
  }

  const order = payload as unknown as ShopifyOrderPaidPayload;

  // Which location ships which items. Without it Hikyaku would dispatch the
  // whole order from its nearest warehouse, so any failure here (Admin API
  // down, the timeout, routing not settled yet) returns 500 and Shopify
  // retries, rather than sending the order without groups.
  let fulfillmentOrders: ShopifyFulfillmentOrder[] | null;
  try {
    const admin = await adminForShop(shop);
    fulfillmentOrders = await getOrderFulfillmentOrders(
      admin,
      order.admin_graphql_api_id,
      { signal: AbortSignal.timeout(FULFILLMENT_ORDERS_TIMEOUT_MS) },
    );
  } catch (error) {
    console.error(
      `Reading fulfillment orders failed for ${shop} (${webhookId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Response("Shopify Admin API error", { status: 500 });
  }
  if (!fulfillmentOrders) {
    console.error(
      `Order ${order.admin_graphql_api_id} not found for ${shop} (${webhookId})`,
    );
    return new Response("Order not found", { status: 500 });
  }

  const grouping = buildFulfillmentGroups(
    fulfillmentOrders,
    order.line_items.map(lineItemId),
  );
  if (!grouping.ok) {
    console.log(
      `Deferring orders/paid for ${shop} (${webhookId}): ${grouping.reason}`,
    );
    return new Response("Fulfillment routing not finished", { status: 500 });
  }
  if (grouping.unknownLineItemIds.length > 0) {
    console.warn(
      `Order ${order.admin_graphql_api_id} for ${shop} routes line items missing from the payload, left out: ${grouping.unknownLineItemIds.join(", ")}`,
    );
  }
  if (grouping.groups.length === 0) {
    // Every fulfillment order is fulfilled, cancelled or scheduled for later,
    // so there is nothing to deliver now. Sending the order anyway (with no
    // groups) would have Hikyaku deliver all of it.
    console.log(
      `Skipping orders/paid for ${shop} (${webhookId}): nothing to deliver (${grouping.skipped
        .map((skip) => `${skip.id} ${skip.status}`)
        .join(", ")})`,
    );
    return new Response();
  }

  const event = buildOrderPaidEvent({
    shop,
    webhookId,
    apiVersion,
    payload: order,
    fulfillmentGroups: grouping.groups,
  });

  const result = await postOrderEvent(
    accessToken,
    connection.organisationSlug,
    event,
  );

  if (!result.ok) {
    console.error(
      `Hikyaku order push failed for ${shop} (${event.event.id}): ${result.detail}`,
    );
    if (result.retry) {
      return new Response("Upstream error", { status: 500 });
    }
  }

  return new Response();
}
