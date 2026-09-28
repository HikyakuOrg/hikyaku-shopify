import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { disconnect } from "../lib/hikyaku-api.server";
import { deleteShopSessions } from "../lib/vault-session-storage.server";

// Mandatory for any published app: customers/data_request, customers/redact,
// shop/redact. authenticate.webhook verifies the HMAC and answers 401 itself
// when it doesn't match, so the handler only runs for genuine Shopify calls.
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
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await deleteShopSessions(shop);
    await disconnect(shop);
    await prisma.hikyakuOAuthState.deleteMany({ where: { shop } });
  }

  return new Response();
}
