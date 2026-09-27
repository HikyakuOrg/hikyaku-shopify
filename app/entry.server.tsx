import { handleRequest } from "@vercel/react-router/entry.server";
import type { AppLoadContext, EntryContext } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";

// Vercel's streaming renderer (plain Node — also works self-hosted), wrapped
// so Shopify can add its embedded-app headers (CSP frame-ancestors etc.).
export { streamTimeout } from "@vercel/react-router/entry.server";

export default async function (
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext?: AppLoadContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  return handleRequest(
    request,
    responseStatusCode,
    responseHeaders,
    routerContext,
    loadContext,
  );
}
