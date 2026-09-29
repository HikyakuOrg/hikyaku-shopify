import type { ActionFunctionArgs } from "react-router";
import { disconnect } from "../lib/hikyaku-api.server";
import { isAppInstalled } from "../lib/shopify-admin.server";
import { deleteShopSessions } from "../lib/vault-session-storage.server";
import { verifyWebhook } from "../lib/webhook-verification.server";

// verifyWebhook, not authenticate.webhook: the latter refreshes the expired
// offline token first, which fails once the app is uninstalled, so this
// handler would never run (see webhook-verification.server.ts).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await verifyWebhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Shopify retries a failed delivery for hours, so it can arrive after the
  // merchant has installed the app again. Cleaning up then would drop the new
  // install's session and Hikyaku connection.
  if (await isAppInstalled(shop, AbortSignal.timeout(2000))) {
    console.log(`Ignoring ${topic} for ${shop}: the app is installed again`);
    return new Response();
  }

  // Idempotent: the webhook can be delivered more than once.
  await deleteShopSessions(shop);
  await disconnect(shop);

  return new Response();
};
