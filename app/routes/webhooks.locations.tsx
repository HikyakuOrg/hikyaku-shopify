import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getConnection,
  getValidAccessToken,
  upsertIntegrationLocations,
} from "../lib/hikyaku-api.server";

/** The fields this handler reads from the (REST shaped) location payload. */
interface LocationPayload {
  admin_graphql_api_id?: string;
  name?: string | null;
  country_code?: string | null;
}

// Shopify gives a webhook 5 seconds end to end; the Hikyaku call gets 4 of
// them, as the orders/paid push does.
const UPSERT_TIMEOUT_MS = 4000;

// locations/create, locations/update, locations/activate and
// locations/deactivate all carry the full location, so they share one
// behaviour: upsert its name and country to hikyaku-api without a mode. A new
// location arrives `unmapped`; an existing one keeps whatever the merchant
// mapped it to. The payload already has everything sent, so there is no Admin
// API call here. authenticate.webhook throws a 401 on a bad HMAC.
//
// The response status follows the orders/paid retry contract (see
// postOrderEvent in hikyaku-api.server.ts): 500 asks Shopify to retry
// (5xx, network error, timeout), 200 means retrying won't help.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const location = payload as LocationPayload;

  const locationId = location.admin_graphql_api_id;
  if (!locationId) {
    console.error(`Skipping ${topic} for ${shop}: payload has no location id`);
    return new Response();
  }

  const connection = await getConnection(shop);
  if (!connection || !connection.organisationSlug) {
    console.log(`Skipping ${topic} for ${shop}: not connected to Hikyaku yet`);
    return new Response();
  }

  const accessToken = await getValidAccessToken(shop);
  if (!accessToken) {
    // The connection was deleted between the two lookups above.
    console.error(`Lost Hikyaku connection for ${shop} mid-request`);
    return new Response();
  }

  const result = await upsertIntegrationLocations(
    accessToken,
    connection.organisationSlug,
    shop,
    [
      {
        external_location_id: locationId,
        external_location_name: location.name ?? null,
        country_code: location.country_code
          ? location.country_code.toUpperCase()
          : null,
      },
    ],
    { timeoutMs: UPSERT_TIMEOUT_MS },
  );

  if (!result.ok) {
    // A 403 is the connected account missing integrations.locations.write.
    // Retrying won't help, and nothing is lost for good: the Home banner
    // counts from Shopify's live list, so the merchant still sees the location
    // as unmapped, and the Locations screen explains the missing permission
    // and syncs every location once the account has it.
    console.error(
      result.status === 403
        ? `Hikyaku location upsert refused for ${shop} (${topic} ${locationId}): the connected account can't change location mappings (${result.detail})`
        : `Hikyaku location upsert failed for ${shop} (${topic} ${locationId}): ${result.detail}`,
    );
    if (result.retry) {
      return new Response("Upstream error", { status: 500 });
    }
  }

  return new Response();
}
