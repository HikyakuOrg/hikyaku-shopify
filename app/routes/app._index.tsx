import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  disconnect,
  fetchIntegrationLocations,
  fetchOrderEvents,
  fetchOrganisations,
  getConnection,
  getValidAccessToken,
  saveOrganisation,
  type HikyakuOrganisation,
} from "../lib/hikyaku-api.server";
import { createAuthorizationRequest } from "../lib/hikyaku-oauth.server";
import { listLocations, listOrders } from "../lib/shopify-admin.server";
import { countUnmapped } from "../lib/location-mapping";
import {
  ORDER_IMPORT_LIMIT,
  importableOrdersSearch,
} from "../lib/order-import";
import { UnmappedLocationsBanner } from "../components/unmapped-locations-banner";
import { EarlierOrdersBanner } from "../components/earlier-orders-banner";

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
      /** Active locations not mapped yet; null if it couldn't be worked out. */
      unmappedLocations: number | null;
      /** Orders from before connecting that Hikyaku lacks; null if unknown. */
      earlierOrders: { count: number; more: boolean } | null;
    }
  | { status: "error"; message: string };

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const connection = await getConnection(shop);
  if (!connection) {
    return { status: "disconnected" };
  }

  if (connection.organisationSlug) {
    const [unmapped, earlier] = await Promise.all([
      unmappedLocations(admin, shop, connection.organisationSlug),
      earlierOrders(
        admin,
        shop,
        connection.organisationSlug,
        connection.createdAt,
      ),
    ]);
    return {
      status: "connected",
      email: connection.hikyakuEmail,
      organisationName: connection.organisationName,
      unmappedLocations: unmapped,
      earlierOrders: earlier,
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

// Shopify's live location list decides which locations count (active and
// fulfilling online orders), Hikyaku's stored rows decide which are mapped. A
// location Hikyaku hasn't stored yet counts as unmapped, so a new location
// shows up here even if its locations/create webhook hasn't landed.
async function unmappedLocations(
  admin: Parameters<typeof listLocations>[0],
  shop: string,
  organisationSlug: string,
): Promise<number | null> {
  try {
    const accessToken = await getValidAccessToken(shop);
    if (!accessToken) return null;
    const [locations, stored] = await Promise.all([
      listLocations(admin),
      fetchIntegrationLocations(accessToken, organisationSlug, shop),
    ]);
    if (!stored.ok) {
      console.error(
        `Couldn't list Hikyaku locations for ${shop}: ${stored.detail}`,
      );
      return null;
    }
    return countUnmapped(locations, stored.data);
  } catch (error) {
    console.error(`Couldn't count unmapped locations for ${shop}`, error);
    return null;
  }
}

// Orders paid before the store was connected never had an orders/paid for
// Hikyaku. Checks the newest page of those still waiting to ship against what
// Hikyaku has, which an import or a webhook retry may have added since.
async function earlierOrders(
  admin: Parameters<typeof listOrders>[0],
  shop: string,
  organisationSlug: string,
  connectedAt: Date,
): Promise<{ count: number; more: boolean } | null> {
  try {
    const accessToken = await getValidAccessToken(shop);
    if (!accessToken) return null;
    const page = await listOrders(admin, importableOrdersSearch(connectedAt), {
      size: ORDER_IMPORT_LIMIT,
    });
    if (page.orders.length === 0) return { count: 0, more: false };
    const events = await fetchOrderEvents(
      accessToken,
      organisationSlug,
      page.orders.map((order) => order.id),
    );
    if (!events.ok) {
      console.error(
        `Couldn't list Hikyaku order events for ${shop}: ${events.detail}`,
      );
      return null;
    }
    const known = new Set(
      events.data
        .filter((event) => event.eventType === "order.paid")
        .map((event) => event.externalOrderId),
    );
    return {
      count: page.orders.filter((order) => !known.has(order.id)).length,
      more: page.pageInfo.hasNextPage,
    };
  } catch (error) {
    console.error(`Couldn't count earlier orders for ${shop}`, error);
    return null;
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
    // Mapping locations is the next step of setting up the store, then
    // choosing which earlier orders to send.
    throw redirect("/app/locations?setup=1");
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

      {data.status === "connected" && !!data.unmappedLocations && (
        <UnmappedLocationsBanner count={data.unmappedLocations} />
      )}

      {data.status === "connected" && !!data.earlierOrders?.count && (
        <EarlierOrdersBanner
          count={data.earlierOrders.count}
          more={data.earlierOrders.more}
        />
      )}

      {data.status === "connected" && (
        <s-section heading="Connected">
          <s-paragraph>
            Signed in to Hikyaku as {data.email}. Paid orders on this store are
            pushed to{" "}
            <strong>{data.organisationName ?? "your organisation"}</strong>.
          </s-paragraph>
          <s-paragraph>
            Each store location ships from one of your Hikyaku warehouses, or
            isn&apos;t delivered by Hikyaku at all.
          </s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button href="/app/locations">Map locations</s-button>
            <s-button href="/app/orders">Add earlier orders</s-button>
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
          </s-stack>
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
