import { useEffect, useRef, useState, type FormEvent } from "react";
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
  describeFailure,
  fetchOrderEvents,
  hikyakuAccess,
  type OrderEventRecord,
} from "../lib/hikyaku-api.server";
import {
  listOrders,
  type OrderPage,
  type ShopifyOrderSummary,
} from "../lib/shopify-admin.server";
import {
  ORDER_IMPORT_LIMIT,
  importableOrdersSearch,
} from "../lib/order-import";
import {
  importOrders,
  type OrderImportOutcome,
} from "../lib/order-import.server";

interface OrderRow {
  /** Order GID. */
  id: string;
  name: string;
  date: string;
  recipient: string | null;
  destination: string | null;
  total: string;
  fulfillment: string;
  /** What Hikyaku made of the order, or null if it doesn't have it. */
  inHikyaku: { attention: boolean; error: string | null } | null;
}

type LoaderData =
  | {
      status: "ready";
      rows: OrderRow[];
      pageInfo: OrderPage["pageInfo"];
      /** Set when Hikyaku couldn't say which orders it already has. */
      eventsError: string | null;
    }
  | { status: "error"; message: string };

type ActionData = { outcomes: OrderImportOutcome[] } | { error: string };

const ORDER_ID = /^gid:\/\/shopify\/Order\/\d+$/;

const dateFormat = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" });

function formatMoney(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(
      Number(amount),
    );
  } catch {
    return `${amount} ${currency}`;
  }
}

function sentenceCase(status: string): string {
  const words = status.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildRow(
  order: ShopifyOrderSummary,
  event: OrderEventRecord | undefined,
): OrderRow {
  const address = order.shippingAddress;
  return {
    id: order.id,
    name: order.name,
    date: dateFormat.format(new Date(order.processedAt)),
    recipient: address?.name ?? order.customer?.displayName ?? null,
    destination:
      [address?.city, address?.provinceCode, address?.countryCodeV2]
        .filter(Boolean)
        .join(", ") || null,
    total: formatMoney(
      order.totalPriceSet.shopMoney.amount,
      order.totalPriceSet.shopMoney.currencyCode,
    ),
    fulfillment: sentenceCase(order.displayFulfillmentStatus),
    inHikyaku: event
      ? {
          attention:
            event.status === "needs_attention" || event.status === "failed",
          error: event.error,
        }
      : null,
  };
}

// Lists the shop's open, paid orders still to ship, newest first, and marks
// the ones Hikyaku already has (from orders/paid or an earlier import).
export async function loader({
  request,
}: LoaderFunctionArgs): Promise<LoaderData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) throw redirect("/app");

  const url = new URL(request.url);
  let page: OrderPage;
  try {
    page = await listOrders(admin, importableOrdersSearch(), {
      size: ORDER_IMPORT_LIMIT,
      after: url.searchParams.get("after"),
      before: url.searchParams.get("before"),
    });
  } catch (error) {
    console.error(`Couldn't list Shopify orders for ${shop}`, error);
    return {
      status: "error",
      message: "Couldn't read this store's orders from Shopify.",
    };
  }

  // Newest first, so the first order.paid of each order is its latest.
  const events = new Map<string, OrderEventRecord>();
  let eventsError: string | null = null;
  if (page.orders.length > 0) {
    const result = await fetchOrderEvents(
      hikyaku.accessToken,
      hikyaku.organisationSlug,
      page.orders.map((order) => order.id),
    );
    if (result.ok) {
      for (const event of result.data) {
        if (
          event.eventType === "order.paid" &&
          !events.has(event.externalOrderId)
        ) {
          events.set(event.externalOrderId, event);
        }
      }
    } else {
      console.error(
        `Couldn't list Hikyaku order events for ${shop}: ${result.detail}`,
      );
      eventsError = describeFailure(
        result,
        "check which orders Hikyaku already has",
      );
    }
  }

  return {
    status: "ready",
    rows: page.orders.map((order) => buildRow(order, events.get(order.id))),
    pageInfo: page.pageInfo,
    eventsError,
  };
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<ActionData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const hikyaku = await hikyakuAccess(shop);
  if (!hikyaku) {
    return { error: "This store isn't connected to Hikyaku any more." };
  }

  const formData = await request.formData();
  if (formData.get("intent") !== "import") {
    return { error: "Unknown action." };
  }
  const orderIds = [
    ...new Set(
      formData
        .getAll("orderId")
        .filter(
          (id): id is string => typeof id === "string" && ORDER_ID.test(id),
        ),
    ),
  ];
  if (orderIds.length === 0) return { error: "Choose at least one order." };
  if (orderIds.length > ORDER_IMPORT_LIMIT) {
    return {
      error: `Choose at most ${ORDER_IMPORT_LIMIT} orders at a time.`,
    };
  }

  const outcomes = await importOrders({
    admin,
    shop,
    accessToken: hikyaku.accessToken,
    organisationSlug: hikyaku.organisationSlug,
    orderIds,
  });
  return { outcomes };
}

type CheckboxElement = HTMLElement & {
  checked: boolean;
  indeterminate: boolean;
};

/**
 * The order checkboxes and their "select all", wired to the DOM directly:
 * React 18 can't listen to the `s-checkbox` change event. New rows (the next
 * page, or the list reloaded after an import) start with nothing selected.
 */
function useOrderSelection(rows: OrderRow[] | null) {
  const tableRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const root = tableRef.current;
    if (!root) {
      setSelected([]);
      return;
    }
    const all = root.querySelector<CheckboxElement>("s-checkbox[data-all]");
    const boxes = Array.from(
      root.querySelectorAll<CheckboxElement>("s-checkbox[data-order-id]"),
    ).filter((box) => !box.hasAttribute("disabled"));
    for (const box of boxes) box.checked = false;

    const update = () => {
      const checked = boxes.filter((box) => box.checked);
      setSelected(checked.map((box) => box.dataset.orderId as string));
      if (all) {
        all.checked = boxes.length > 0 && checked.length === boxes.length;
        all.indeterminate = checked.length > 0 && checked.length < boxes.length;
      }
    };
    const selectAll = () => {
      const check = boxes.some((box) => !box.checked);
      for (const box of boxes) box.checked = check;
      update();
    };

    update();
    for (const box of boxes) box.addEventListener("change", update);
    all?.addEventListener("change", selectAll);
    return () => {
      for (const box of boxes) box.removeEventListener("change", update);
      all?.removeEventListener("change", selectAll);
    };
  }, [rows]);

  return { tableRef, selected };
}

function ImportResults({ outcomes }: { outcomes: OrderImportOutcome[] }) {
  const sent = outcomes.filter((outcome) => outcome.status === "sent");
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  const skipped = outcomes.filter((outcome) => outcome.status === "skipped");
  const label = (outcome: OrderImportOutcome) =>
    outcome.name ?? outcome.orderId;
  return (
    <>
      {sent.length > 0 && (
        <s-banner
          heading={
            sent.length === 1
              ? `${label(sent[0])} was added to Hikyaku`
              : `${sent.length} orders were added to Hikyaku`
          }
          tone="success"
        >
          Hikyaku is creating their deliveries now. Any that need a fix show up
          under orders that need attention in Hikyaku.
        </s-banner>
      )}
      {failed.length > 0 && (
        <s-banner
          heading={
            failed.length === 1
              ? `${label(failed[0])} couldn't be added`
              : `${failed.length} orders couldn't be added`
          }
          tone="critical"
        >
          <s-unordered-list>
            {failed.map((outcome) => (
              <s-list-item key={outcome.orderId}>
                {label(outcome)}: {outcome.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
      {skipped.length > 0 && (
        <s-banner
          heading={
            skipped.length === 1
              ? `${label(skipped[0])} wasn't sent`
              : `${skipped.length} orders weren't sent`
          }
          tone="info"
        >
          <s-unordered-list>
            {skipped.map((outcome) => (
              <s-list-item key={outcome.orderId}>
                {label(outcome)}: {outcome.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}
    </>
  );
}

function HikyakuStatus({ row }: { row: OrderRow }) {
  if (!row.inHikyaku) return <s-badge>Not in Hikyaku</s-badge>;
  if (row.inHikyaku.attention) {
    return (
      <s-stack gap="small-300">
        <s-badge tone="warning">Needs attention in Hikyaku</s-badge>
        {row.inHikyaku.error && (
          <s-text color="subdued">{row.inHikyaku.error}</s-text>
        )}
      </s-stack>
    );
  }
  return <s-badge tone="success">In Hikyaku</s-badge>;
}

export default function Orders() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      "outcomes" in fetcher.data
    ) {
      const sent = fetcher.data.outcomes.filter(
        (outcome) => outcome.status === "sent",
      ).length;
      if (sent > 0) {
        shopify.toast.show(
          sent === 1 ? "Order added to Hikyaku" : `${sent} orders added`,
        );
      }
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const { tableRef, selected } = useOrderSelection(
    data.status === "ready" ? data.rows : null,
  );

  // The selection lives in the s-checkbox elements, so the form data is
  // built from them rather than left to the form.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected.length === 0) return;
    const formData = new FormData();
    formData.set("intent", "import");
    for (const id of selected) formData.append("orderId", id);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <s-page heading="Orders">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      {data.status === "error" ? (
        <s-banner heading="Couldn't load orders" tone="critical">
          {data.message}
        </s-banner>
      ) : (
        <form onSubmit={submit}>
          {fetcher.data && "error" in fetcher.data && (
            <s-banner heading="Couldn't add orders" tone="critical">
              {fetcher.data.error}
            </s-banner>
          )}
          {fetcher.data && "outcomes" in fetcher.data && (
            <ImportResults outcomes={fetcher.data.outcomes} />
          )}
          {data.eventsError && (
            <s-banner heading="Couldn't check Hikyaku" tone="warning">
              {data.eventsError} Adding an order Hikyaku already has
              doesn&apos;t create a second delivery.
            </s-banner>
          )}
          <s-section heading="Paid orders waiting to ship">
            <s-paragraph>
              Orders paid before this store was connected to Hikyaku
              weren&apos;t sent there. Choose the ones Hikyaku should deliver:
              each is added like a new paid order, shipping from its
              location&apos;s warehouse. Shopify shows apps the orders of the
              last 60 days.
            </s-paragraph>
            {data.rows.length === 0 ? (
              <s-paragraph>No paid orders are waiting to ship.</s-paragraph>
            ) : (
              <div ref={tableRef}>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>
                      <s-checkbox
                        data-all=""
                        accessibilityLabel="Select every order on this page"
                      />
                    </s-table-header>
                    <s-table-header listSlot="primary">Order</s-table-header>
                    <s-table-header>Customer</s-table-header>
                    <s-table-header format="numeric">Total</s-table-header>
                    <s-table-header>Fulfillment</s-table-header>
                    <s-table-header listSlot="secondary">
                      Hikyaku
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.rows.map((row) => (
                      <s-table-row key={row.id}>
                        <s-table-cell>
                          <s-checkbox
                            data-order-id={row.id}
                            accessibilityLabel={`Select ${row.name}`}
                            {...(row.inHikyaku ? { disabled: true } : {})}
                          />
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack gap="small-500">
                            <s-text type="strong">{row.name}</s-text>
                            <s-text color="subdued">{row.date}</s-text>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack gap="small-500">
                            <s-text>{row.recipient ?? "No customer"}</s-text>
                            {row.destination && (
                              <s-text color="subdued">{row.destination}</s-text>
                            )}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>{row.total}</s-table-cell>
                        <s-table-cell>{row.fulfillment}</s-table-cell>
                        <s-table-cell>
                          <HikyakuStatus row={row} />
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </div>
            )}
          </s-section>

          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
            paddingBlock="base"
          >
            <s-stack direction="inline" gap="small-300">
              {data.pageInfo.hasPreviousPage && data.pageInfo.startCursor && (
                <s-button
                  href={`/app/orders?before=${encodeURIComponent(data.pageInfo.startCursor)}`}
                >
                  Newer orders
                </s-button>
              )}
              {data.pageInfo.hasNextPage && data.pageInfo.endCursor && (
                <s-button
                  href={`/app/orders?after=${encodeURIComponent(data.pageInfo.endCursor)}`}
                >
                  Older orders
                </s-button>
              )}
            </s-stack>
            <s-button
              type="submit"
              variant="primary"
              {...(busy ? { loading: true } : {})}
              {...(selected.length === 0 ? { disabled: true } : {})}
            >
              {selected.length === 1
                ? "Add 1 order to Hikyaku"
                : `Add ${selected.length} orders to Hikyaku`}
            </s-button>
          </s-stack>
        </form>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
