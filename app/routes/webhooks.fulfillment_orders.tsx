import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getConnection,
  getValidAccessToken,
  postOrderEvent,
} from "../lib/hikyaku-api.server";
import { buildOrderFulfillmentUpdatedEvent } from "../lib/order-event.server";
import { buildFulfillmentGroups } from "../lib/fulfillment-groups";
import {
  readFulfillmentOrderChange,
  type FulfillmentOrderWebhookPayload,
} from "../lib/fulfillment-order-webhook";
import {
  adminForShop,
  getFulfillmentOrderOrder,
  type ShopifyOrderFulfillment,
} from "../lib/shopify-admin.server";

// Of the 5 seconds Shopify allows, the POST to hikyaku-api takes up to 4, so
// the fulfillment order reads get about 1, as in orders/paid.
const FULFILLMENT_ORDERS_TIMEOUT_MS = 1000;

// fulfillment_orders/moved, fulfillment_orders/split, fulfillment_orders/merged
// and fulfillment_orders/cancelled: a paid order's items were re-routed after
// orders/paid already reached Hikyaku. fulfillment_orders/
// scheduled_fulfillment_order_ready: a SCHEDULED fulfillment order (left out
// at orders/paid, such as a prepaid subscription's next box) is now due, so
// it becomes a group to deliver. The payloads only name fulfillment
// orders, so this reads the order they belong to and all of its fulfillment
// orders as they are now, and sends Hikyaku an order.fulfillment_updated
// event: the order's groups now, plus the fulfillment orders the change
// released items from. Hikyaku then replaces or drops the packages that no
// longer match.
//
// Same retry contract as orders/paid: anything that leaves the routing
// unknown (Admin API error or timeout, routing not settled) or a 5xx from
// hikyaku-api returns 500 so Shopify retries; a 4xx returns 200. Each webhook
// is sent under its own id as the Idempotency-Key, so a retry is safe, and
// since every event carries the whole routing, events arriving out of order
// settle on the latest one Hikyaku receives.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const connection = await getConnection(shop);
  if (!connection || !connection.organisationSlug) {
    console.log(`Skipping ${topic} for ${shop}: not connected to Hikyaku yet`);
    return new Response();
  }

  const change = readFulfillmentOrderChange(
    topic,
    payload as FulfillmentOrderWebhookPayload,
  );
  if (change.lookupIds.length === 0) {
    console.warn(
      `Skipping ${topic} for ${shop} (${webhookId}): no fulfillment order in the payload`,
    );
    return new Response();
  }

  const accessToken = await getValidAccessToken(shop);
  if (!accessToken) {
    console.error(`Lost Hikyaku connection for ${shop} mid-request`);
    return new Response();
  }

  let found: ShopifyOrderFulfillment | null = null;
  try {
    const admin = await adminForShop(shop);
    const signal = AbortSignal.timeout(FULFILLMENT_ORDERS_TIMEOUT_MS);
    // Every fulfillment order in the payload belongs to the same order; a
    // merged or cancelled one may no longer be readable, so try the next.
    for (const id of change.lookupIds) {
      found = await getFulfillmentOrderOrder(admin, id, { signal });
      if (found) break;
    }
  } catch (error) {
    console.error(
      `Reading fulfillment orders failed for ${shop} (${webhookId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Response("Shopify Admin API error", { status: 500 });
  }
  if (!found) {
    // Shopify retries, but the ids won't come back: this ends in its
    // retry budget, and Hikyaku keeps the packages it had.
    console.error(
      `Fulfillment orders ${change.lookupIds.join(", ")} not found for ${shop} (${webhookId})`,
    );
    return new Response("Fulfillment order not found", { status: 500 });
  }

  const grouping = buildFulfillmentGroups(found.fulfillmentOrders, null);
  if (!grouping.ok) {
    console.log(
      `Deferring ${topic} for ${shop} (${webhookId}): ${grouping.reason}`,
    );
    return new Response("Fulfillment routing not finished", { status: 500 });
  }

  // Sent even when no group is left: that's how Hikyaku learns the released
  // fulfillment orders are gone.
  const event = buildOrderFulfillmentUpdatedEvent({
    shop,
    webhookId,
    apiVersion,
    order: found.order,
    fulfillmentGroups: grouping.groups,
    releasedGroupIds: change.releasedIds,
    occurredAt: new Date(),
  });

  const result = await postOrderEvent(
    accessToken,
    connection.organisationSlug,
    event,
  );

  if (!result.ok) {
    console.error(
      `Hikyaku re-routing push failed for ${shop} (${event.event.id}): ${result.detail}`,
    );
    if (result.retry) {
      return new Response("Upstream error", { status: 500 });
    }
  }

  return new Response();
}
