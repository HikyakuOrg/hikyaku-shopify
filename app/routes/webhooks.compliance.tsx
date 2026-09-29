import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { disconnect } from "../lib/hikyaku-api.server";
import { deleteShopSessions } from "../lib/vault-session-storage.server";
import { verifyWebhook } from "../lib/webhook-verification.server";

// Mandatory for any published app: customers/data_request, customers/redact,
// shop/redact. verifyWebhook checks the HMAC and answers 401 itself when it
// doesn't match, so the handler only runs for genuine Shopify calls. Not
// authenticate.webhook: these arrive for shops that have uninstalled, whose
// expired offline token it would fail to refresh, answering 500 without
// running the handler (see webhook-verification.server.ts).
//
// Customer data: this app stores none. Orders are transformed and forwarded to
// hikyaku-api without being persisted here, and the rows we do keep (sessions,
// the Hikyaku connection, PKCE state) belong to the merchant, not their
// customers. So customers/data_request and customers/redact have nothing to
// export or erase and answer 200. The recipient details Hikyaku received with
// each order are held by Hikyaku as the merchant's processor, which handles
// those requests there.
//
// shop/redact (48 hours after uninstall) removes everything we hold for the
// shop. It is idempotent: app/uninstalled has usually removed most of it
// already, and Shopify may retry. Location mappings live in Hikyaku, not here.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop } = await verifyWebhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await deleteShopSessions(shop);
    await disconnect(shop);
    await prisma.hikyakuOAuthState.deleteMany({ where: { shop } });
  }

  return new Response();
}
