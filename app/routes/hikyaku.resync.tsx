import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyHikyakuPush } from "../lib/hikyaku-push.server";
import { syncStaticRates } from "../lib/static-rates.server";
import { adminForShop } from "../lib/shopify-admin.server";

// hikyaku-api's signed push (see hikyaku-push.server.ts): something behind
// this shop's static Hikyaku rates changed, so rewrite them and the
// Function's metafields. Shops on the live path, or with rates off, have
// nothing to rewrite: the carrier service asks hikyaku-api at every checkout.
//
// 200 when done or nothing to do. 500 when Shopify or hikyaku-api failed, so
// hikyaku-api retries the push; a partial failure is also kept on
// ShippingRates.error for the settings screen.
export async function action({ request }: ActionFunctionArgs) {
  const push = await verifyHikyakuPush(request);
  const shop = push.shop_domain;

  const state = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { enabled: true, path: true },
  });
  if (!state?.enabled || state.path !== "static") {
    console.log(
      `Ignoring Hikyaku resync for ${shop} (${push.reasons.join(", ")}): static rates aren't on`,
    );
    return new Response();
  }

  let admin;
  try {
    admin = await adminForShop(shop);
  } catch (error) {
    // No offline session: the app was uninstalled. Nothing to rewrite.
    console.warn(
      `Ignoring Hikyaku resync for ${shop}: no Shopify session (${error instanceof Error ? error.message : String(error)})`,
    );
    return new Response();
  }

  const result = await syncStaticRates(admin, shop);
  console.log(
    `Hikyaku resync for ${shop} (${push.reasons.join(", ")}): ${result.mutations} mutation(s)${result.ok ? "" : `, failed: ${result.errors.join(" ")}`}`,
  );
  return new Response(undefined, { status: result.ok ? 200 : 500 });
}
