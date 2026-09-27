import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory for any published app: customers/data_request, customers/redact,
// shop/redact. This app persists no customer data of its own — Hikyaku's
// backend is the system of record and is responsible for actual redaction;
// see docs/BACKEND_HANDOFF.md.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  return new Response();
}
