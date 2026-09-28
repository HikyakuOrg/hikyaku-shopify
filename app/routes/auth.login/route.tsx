import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { MARKETING_URL } from "../../lib/marketing";
import { login } from "../../shopify.server";

// A valid `?shop=` starts an install: login() throws a redirect to the shop's
// admin. Hikyaku's Connected Apps sends merchants here that way. Anything else
// (no shop, an invalid one, or authenticate.admin bouncing a request made
// outside the admin) goes to Hikyaku's page about the app: the template's
// shop-domain form is gone, since App Store requirement 2.3.1 forbids asking
// for the shop domain.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await login(request);
  throw redirect(MARKETING_URL);
};
