import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { reconcileRates } from "../lib/rates-setup.server";
import { adminForShop } from "../lib/shopify-admin.server";

/** The fields this handler reads from the (REST shaped) shop payload. */
interface ShopPayload {
  plan_display_name?: string | null;
  currency?: string | null;
}

// shop/update: with Hikyaku rates on, a plan change can move the shop between
// the live path (carrier service) and the static one, and a currency change
// reprices every rate. Any other change to the shop is ignored, so most
// deliveries return at once.
//
// 500 only when the re-check itself threw, so Shopify retries. A step that
// failed is kept in ShippingRates.error and retried on the next load of the
// Shipping rates screen.
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const update = payload as ShopPayload;

  const state = await prisma.shippingRates.findUnique({
    where: { shop },
    select: { enabled: true, shopPlan: true, shopCurrency: true, error: true },
  });
  if (!state?.enabled) return new Response();
  const planChanged =
    !!update.plan_display_name && update.plan_display_name !== state.shopPlan;
  const currencyChanged =
    !!update.currency && update.currency !== state.shopCurrency;
  if (!planChanged && !currencyChanged && !state.error) {
    return new Response();
  }

  try {
    const result = await reconcileRates(await adminForShop(shop), shop);
    console.log(
      `Re-checked Hikyaku rates for ${shop} after shop/update (plan ${state.shopPlan} → ${update.plan_display_name}, currency ${state.shopCurrency} → ${update.currency}): ${result?.path ?? "off"}${result && !result.ok ? `, failed: ${result.errors.join(" ")}` : ""}`,
    );
  } catch (error) {
    console.error(
      `Re-checking Hikyaku rates failed for ${shop}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Response("Re-check failed", { status: 500 });
  }
  return new Response();
}
