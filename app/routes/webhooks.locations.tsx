import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

interface LocationPayload {
  id?: number;
  admin_graphql_api_id?: string;
}

// locations/create, locations/update, locations/activate and
// locations/deactivate. All four carry the full location, so they will share
// one behaviour: upsert it to hikyaku-api so new or changed locations get
// flagged for depot mapping. That endpoint doesn't exist yet, so for now this
// only verifies the HMAC (authenticate.webhook throws a 401 otherwise) and
// logs the event.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const location = payload as LocationPayload;
  const locationId = location.admin_graphql_api_id ?? location.id;
  console.log(`Received ${topic} webhook for ${shop}: location ${locationId}`);
  return new Response();
}
