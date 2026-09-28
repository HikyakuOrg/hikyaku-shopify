import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { MARKETING_URL } from "../../lib/marketing";

// The Shopify admin opens the app URL with a `shop` param. Anyone else (a
// bookmark, the app's link in Hikyaku's Connected Apps) gets Hikyaku's page
// about the app instead of the template's shop-domain form, which confused
// merchants who had already installed and which App Store requirement 2.3.1
// forbids.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  throw redirect(MARKETING_URL);
};
