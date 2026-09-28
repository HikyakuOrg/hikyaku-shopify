import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

interface FulfillmentOrderRef {
  id?: string;
}

interface FulfillmentOrderPayload {
  // fulfillment_orders/split and fulfillment_orders/cancelled
  fulfillment_order?: FulfillmentOrderRef;
  // fulfillment_orders/moved
  original_fulfillment_order?: FulfillmentOrderRef;
  // fulfillment_orders/merged
  fulfillment_order_merges?: { fulfillment_order?: FulfillmentOrderRef }[];
}

function fulfillmentOrderIds(payload: FulfillmentOrderPayload): string {
  const ids = [
    payload.fulfillment_order?.id,
    payload.original_fulfillment_order?.id,
    ...(payload.fulfillment_order_merges ?? []).map(
      (merge) => merge.fulfillment_order?.id,
    ),
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(", ") : "unknown";
}

// fulfillment_orders/moved, fulfillment_orders/split, fulfillment_orders/merged
// and fulfillment_orders/cancelled: a paid order's items were re-routed to a
// different location after orders/paid already reached Hikyaku. These will be
// forwarded to hikyaku-api so it can re-plan the affected deliveries. That
// endpoint doesn't exist yet, so for now this only verifies the HMAC
// (authenticate.webhook throws a 401 otherwise) and logs the event.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop}: fulfillment order ${fulfillmentOrderIds(
      payload as FulfillmentOrderPayload,
    )}`,
  );
  return new Response();
}
