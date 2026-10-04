import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { apiVersion } from "../shopify.server";
import { postOrderEvent } from "./hikyaku-api.server";
import { buildOrderPaidEvent, lineItemId } from "./order-event.server";
import { buildFulfillmentGroups } from "./fulfillment-groups";
import {
  importEventId,
  notImportableReason,
  orderPaidPayloadFromOrder,
} from "./order-import";
import { getOrder, getOrderFulfillmentOrders } from "./shopify-admin.server";

export type OrderImportOutcome = {
  orderId: string;
  /** The order's name, e.g. `#1001`; null if it couldn't be read. */
  name: string | null;
} & (
  | { status: "sent" }
  /** Nothing to send: cancelled, archived, unpaid or nothing left to deliver. */
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
);

// Two orders at a time: the fulfillment order query asks for a lot of
// Shopify's query cost budget up front, so more would mostly be throttled.
const CONCURRENCY = 2;
const THROTTLE_RETRIES = 2;
const THROTTLE_BACKOFF_MS = 2000;

/**
 * Sends each order to Hikyaku as the order.paid it would have been, with
 * its fulfillment groups read now. Unlike the webhook there is no retrier
 * behind this, so every order gets an outcome to show the merchant, in the
 * order given.
 */
export async function importOrders(params: {
  admin: AdminApiContext;
  shop: string;
  accessToken: string;
  organisationSlug: string;
  orderIds: string[];
}): Promise<OrderImportOutcome[]> {
  const outcomes: OrderImportOutcome[] = new Array(params.orderIds.length);
  let next = 0;
  async function worker() {
    while (next < params.orderIds.length) {
      const index = next++;
      outcomes[index] = await importOrder(params, params.orderIds[index]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return outcomes;
}

async function importOrder(
  params: Parameters<typeof importOrders>[0],
  orderId: string,
): Promise<OrderImportOutcome> {
  const { admin, shop } = params;

  let order: Awaited<ReturnType<typeof getOrder>>;
  let fulfillmentOrders: Awaited<ReturnType<typeof getOrderFulfillmentOrders>>;
  try {
    order = await retryThrottled(() => getOrder(admin, orderId));
    fulfillmentOrders = order
      ? await retryThrottled(() => getOrderFulfillmentOrders(admin, orderId))
      : null;
  } catch (error) {
    console.error(`Reading order ${orderId} failed for ${shop}`, error);
    return {
      orderId,
      name: null,
      status: "failed",
      reason: "Couldn't read it from Shopify. Try again.",
    };
  }
  if (!order || !fulfillmentOrders) {
    return {
      orderId,
      name: order?.name ?? null,
      status: "failed",
      reason: "It no longer exists in Shopify.",
    };
  }
  const name = order.name;

  const notImportable = notImportableReason(order);
  if (notImportable) {
    return { orderId, name, status: "skipped", reason: notImportable };
  }

  const payload = orderPaidPayloadFromOrder(order, fulfillmentOrders);
  const grouping = buildFulfillmentGroups(
    fulfillmentOrders,
    payload.line_items.map(lineItemId),
  );
  if (!grouping.ok) {
    console.log(`Not importing ${orderId} for ${shop}: ${grouping.reason}`);
    return {
      orderId,
      name,
      status: "failed",
      reason:
        "Shopify hasn't finished assigning it to a location. Try again in a minute.",
    };
  }
  if (grouping.groups.length === 0) {
    return {
      orderId,
      name,
      status: "skipped",
      reason: "Nothing is left to deliver.",
    };
  }

  const event = buildOrderPaidEvent({
    shop,
    webhookId: importEventId(order.id),
    apiVersion,
    payload,
    fulfillmentGroups: grouping.groups,
  });
  const result = await postOrderEvent(
    params.accessToken,
    params.organisationSlug,
    event,
  );
  if (!result.ok) {
    console.error(
      `Hikyaku order import failed for ${shop} (${orderId}): ${result.detail}`,
    );
    return {
      orderId,
      name,
      status: "failed",
      reason: /^HTTP 40[13]\b/.test(result.detail)
        ? "Your Hikyaku account isn't allowed to add orders in this organisation."
        : `Hikyaku couldn't take it (${result.detail}). Try again.`,
    };
  }
  return { orderId, name, status: "sent" };
}

// admin.graphql throws a GraphqlQueryError with Shopify's first error message,
// "Throttled", when the query cost bucket runs dry.
async function retryThrottled<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const throttled = error instanceof Error && error.message === "Throttled";
      if (!throttled || attempt >= THROTTLE_RETRIES) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, THROTTLE_BACKOFF_MS * (attempt + 1)),
      );
    }
  }
}
