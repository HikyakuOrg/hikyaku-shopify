import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getConnection,
  getValidAccessToken,
  postOrderEvent,
} from "../lib/hikyaku-api.server";
import {
  buildOrderPaidEvent,
  type ShopifyOrderPaidPayload,
} from "../lib/order-event.server";

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

  const event = buildOrderPaidEvent({
    shop,
    webhookId,
    apiVersion,
    payload: payload as unknown as ShopifyOrderPaidPayload,
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
