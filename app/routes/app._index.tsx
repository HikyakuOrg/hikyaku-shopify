import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  disconnect,
  fetchOrganisations,
  getConnection,
  getValidAccessToken,
  saveOrganisation,
  type HikyakuOrganisation,
} from "../lib/hikyaku-api.server";
import { createAuthorizationRequest } from "../lib/hikyaku-oauth.server";

type LoaderData =
  | { status: "disconnected" }
  | {
      status: "choosing_org";
      email: string;
      organisations: HikyakuOrganisation[];
    }
  | {
      status: "connected";
      email: string;
      organisationName: string | null;
    }
  | { status: "error"; message: string };

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const connection = await getConnection(shop);
  if (!connection) {
    return { status: "disconnected" };
  }

  if (connection.organisationSlug) {
    return {
      status: "connected",
      email: connection.hikyakuEmail,
      organisationName: connection.organisationName,
    };
  }

  try {
    const accessToken = await getValidAccessToken(shop);
    if (!accessToken) return { status: "disconnected" };
    const organisations = await fetchOrganisations(accessToken);
    return {
      status: "choosing_org",
      email: connection.hikyakuEmail,
      organisations,
    };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Couldn't load your Hikyaku organisations.",
    };
  }
}

type ActionData = { authorizeUrl: string } | { ok: true } | { error: string };

export async function action({
  request,
}: ActionFunctionArgs): Promise<ActionData> {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "connect") {
    const authorizeUrl = await createAuthorizationRequest(shop);
    return { authorizeUrl };
  }

  if (intent === "choose_org") {
    const slug = formData.get("organisationSlug");
    if (typeof slug !== "string" || !slug) {
      return { error: "Pick an organisation first." };
    }
    const accessToken = await getValidAccessToken(shop);
    if (!accessToken) {
      return {
        error: "Your Hikyaku connection expired — reconnect and try again.",
      };
    }
    // Re-fetch rather than trust client-supplied org details for anything
    // beyond the slug used to look it up.
    const organisations = await fetchOrganisations(accessToken);
    const org = organisations.find((candidate) => candidate.slug === slug);
    if (!org) {
      return { error: "That organisation is no longer available." };
    }
    await saveOrganisation(shop, org);
    return { ok: true };
  }

  if (intent === "disconnect") {
    await disconnect(shop);
    return { ok: true };
  }

  return { error: "Unknown action." };
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data && "authorizeUrl" in fetcher.data) {
      window.open(fetcher.data.authorizeUrl, "_blank", "noopener,noreferrer");
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data) {
      shopify.toast.show("Saved");
    }
  }, [fetcher.data, shopify]);

  const isBusy = fetcher.state !== "idle";

  return (
    <s-page heading="Hikyaku Connect">
      {data.status === "error" && (
        <s-banner heading="Couldn't load Hikyaku" tone="critical">
          {data.message}
        </s-banner>
      )}

      {fetcher.data && "error" in fetcher.data && (
        <s-banner heading="Something went wrong" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}

      {data.status === "disconnected" && (
        <s-section heading="Connect your Hikyaku account">
          <s-paragraph>
            Connect this store to Hikyaku so paid orders are pushed to your
            delivery workflow automatically.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="connect" />
            <s-button
              type="submit"
              variant="primary"
              {...(isBusy ? { loading: true } : {})}
            >
              Connect Hikyaku
            </s-button>
          </fetcher.Form>
          {fetcher.data && "authorizeUrl" in fetcher.data && (
            <s-paragraph>
              Finish signing in in the new tab, then come back and refresh this
              page.
            </s-paragraph>
          )}
        </s-section>
      )}

      {data.status === "choosing_org" && (
        <s-section heading="Choose your organisation">
          <s-paragraph>
            Signed in to Hikyaku as {data.email}. Pick which organisation this
            store should feed orders into.
          </s-paragraph>
          {data.organisations.length === 0 ? (
            <s-paragraph>
              No organisations found on your Hikyaku account yet. Create one in
              Hikyaku, then refresh this page.
            </s-paragraph>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="choose_org" />
              <s-choice-list name="organisationSlug" label="Organisation">
                {data.organisations.map((org) => (
                  <s-choice key={org.slug} value={org.slug}>
                    {org.name ?? "Personal"}
                  </s-choice>
                ))}
              </s-choice-list>
              <s-button
                type="submit"
                variant="primary"
                {...(isBusy ? { loading: true } : {})}
              >
                Save
              </s-button>
            </fetcher.Form>
          )}
        </s-section>
      )}

      {data.status === "connected" && (
        <s-section heading="Connected">
          <s-paragraph>
            Signed in to Hikyaku as {data.email}. Paid orders on this store are
            pushed to{" "}
            <strong>{data.organisationName ?? "your organisation"}</strong>.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <s-button
              variant="tertiary"
              tone="critical"
              type="submit"
              {...(isBusy ? { loading: true } : {})}
            >
              Disconnect
            </s-button>
          </fetcher.Form>
        </s-section>
      )}

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          When a customer completes a paid order on this store, Hikyaku Connect
          sends the order details to your Hikyaku account so it can be turned
          into a delivery.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
