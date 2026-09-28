import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { OrderFulfillmentUpdatedEvent } from "../lib/order-event.server";
import type { ShopifyFulfillmentOrder } from "../lib/shopify-admin.server";

// The handler with Shopify, the database and hikyaku-api mocked out, so this
// covers the retry contract: which outcomes reach hikyaku-api and which
// status goes back to Shopify.

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock("../lib/hikyaku-api.server", () => ({
  getConnection: vi.fn(),
  getValidAccessToken: vi.fn(),
  postOrderEvent: vi.fn(),
}));
vi.mock("../lib/shopify-admin.server", () => ({
  adminForShop: vi.fn(),
  getFulfillmentOrderOrder: vi.fn(),
}));

const { authenticate } = await import("../shopify.server");
const { getConnection, getValidAccessToken, postOrderEvent } =
  await import("../lib/hikyaku-api.server");
const { adminForShop, getFulfillmentOrderOrder } =
  await import("../lib/shopify-admin.server");
const { action } = await import("../routes/webhooks.fulfillment_orders");

const SHOP = "example.myshopify.com";
const ORDER = { id: "gid://shopify/Order/1001", name: "#1001" };
const fo = (n: number) => `gid://shopify/FulfillmentOrder/${n}`;

// fulfillment_orders/moved: fulfillment order 1 moved to location 102 as 2.
const MOVED = {
  original_fulfillment_order: {
    id: fo(1),
    status: "closed",
    assigned_location_id: "gid://shopify/Location/101",
  },
  moved_fulfillment_order: {
    id: fo(2),
    status: "open",
    assigned_location_id: "gid://shopify/Location/102",
  },
  destination_location_id: "gid://shopify/Location/102",
  fulfillment_order_line_items_requested: [],
  source_location: { id: "gid://shopify/Location/101" },
};

function fulfillmentOrder(
  id: number,
  locationId: number,
  lineItems: Array<[lineItemId: number, quantity: number]>,
  status = "OPEN",
): ShopifyFulfillmentOrder {
  return {
    id: fo(id),
    status,
    assignedLocation: {
      name: `Location ${locationId}`,
      location: { id: `gid://shopify/Location/${locationId}` },
    },
    deliveryMethod: { methodType: "SHIPPING" },
    lineItems: lineItems.map(([lineItemId, quantity]) => ({
      id: `gid://shopify/FulfillmentOrderLineItem/${lineItemId}`,
      totalQuantity: quantity,
      remainingQuantity: quantity,
      lineItem: { id: `gid://shopify/LineItem/${lineItemId}` },
      weight: { value: 100, unit: "GRAMS" },
    })),
  };
}

function webhook(topic: string, payload: unknown) {
  vi.mocked(authenticate.webhook).mockResolvedValue({
    shop: SHOP,
    payload,
    webhookId: "webhook-7",
    apiVersion: "2026-07",
    topic,
  } as unknown as Awaited<ReturnType<typeof authenticate.webhook>>);
}

function callAction() {
  return action({
    request: new Request("https://app.example/webhooks/fulfillment_orders", {
      method: "POST",
    }),
  } as ActionFunctionArgs);
}

function postedEvent(): OrderFulfillmentUpdatedEvent {
  expect(postOrderEvent).toHaveBeenCalledTimes(1);
  return vi.mocked(postOrderEvent).mock
    .calls[0][2] as OrderFulfillmentUpdatedEvent;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  webhook("FULFILLMENT_ORDERS_MOVED", MOVED);
  vi.mocked(getConnection).mockResolvedValue({
    organisationSlug: "acme",
  } as Awaited<ReturnType<typeof getConnection>>);
  vi.mocked(getValidAccessToken).mockResolvedValue("token");
  vi.mocked(adminForShop).mockResolvedValue(
    {} as Awaited<ReturnType<typeof adminForShop>>,
  );
  vi.mocked(postOrderEvent).mockResolvedValue({ ok: true });
});

describe("fulfillment_orders/* webhook", () => {
  it("sends the order's routing now, releasing the fulfillment order moved out of", async () => {
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue({
      order: ORDER,
      fulfillmentOrders: [
        fulfillmentOrder(1, 101, [[11, 2]], "CLOSED"),
        fulfillmentOrder(2, 102, [[11, 2]]),
        fulfillmentOrder(3, 101, [[12, 1]]),
      ],
    });

    const response = await callAction();

    expect(response.status).toBe(200);
    // Looked up through the fulfillment order most likely to exist.
    expect(getFulfillmentOrderOrder).toHaveBeenCalledWith(
      expect.anything(),
      fo(2),
      { signal: expect.any(AbortSignal) },
    );
    expect(postOrderEvent).toHaveBeenCalledWith("token", "acme", {
      event: {
        id: "webhook-7",
        type: "order.fulfillment_updated",
        occurred_at: expect.any(String),
        api_version: "2026-07",
      },
      source: {
        platform: "shopify",
        shop_domain: SHOP,
        app_version: "0.1.0",
      },
      order: ORDER,
      fulfillment_groups: [
        {
          id: fo(2),
          external_location_id: "gid://shopify/Location/102",
          external_location_name: "Location 102",
          delivery_method: "shipping",
          line_items: [{ line_item_id: "11", quantity: 2 }],
          total_weight_grams: 200,
        },
        {
          id: fo(3),
          external_location_id: "gid://shopify/Location/101",
          external_location_name: "Location 101",
          delivery_method: "shipping",
          line_items: [{ line_item_id: "12", quantity: 1 }],
          total_weight_grams: 100,
        },
      ],
      released_group_ids: [fo(1)],
    });
  });

  it("tries the next fulfillment order when the first can't be read", async () => {
    vi.mocked(getFulfillmentOrderOrder)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        order: ORDER,
        fulfillmentOrders: [fulfillmentOrder(2, 102, [[11, 2]])],
      });

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(
      vi.mocked(getFulfillmentOrderOrder).mock.calls.map(([, id]) => id),
    ).toEqual([fo(2), fo(1)]);
    expect(postedEvent().order).toEqual(ORDER);
  });

  it("sends an update with no groups when nothing is left to deliver", async () => {
    webhook("FULFILLMENT_ORDERS_CANCELLED", {
      fulfillment_order: { id: fo(1), status: "cancelled" },
    });
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue({
      order: ORDER,
      fulfillmentOrders: [fulfillmentOrder(1, 101, [[11, 2]], "CANCELLED")],
    });

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(postedEvent()).toMatchObject({
      fulfillment_groups: [],
      released_group_ids: [fo(1)],
    });
  });

  it("releases nothing when a scheduled fulfillment order comes due", async () => {
    webhook("FULFILLMENT_ORDERS_SCHEDULED_FULFILLMENT_ORDER_READY", {
      fulfillment_order: { id: fo(4), status: "open" },
    });
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue({
      order: ORDER,
      fulfillmentOrders: [
        fulfillmentOrder(1, 101, [[11, 1]], "CLOSED"),
        fulfillmentOrder(4, 101, [[11, 1]]),
      ],
    });

    await callAction();

    expect(postedEvent()).toMatchObject({
      fulfillment_groups: [{ id: fo(4) }],
      released_group_ids: [],
    });
  });

  it("skips a shop that isn't connected to Hikyaku", async () => {
    vi.mocked(getConnection).mockResolvedValue(null);

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(getFulfillmentOrderOrder).not.toHaveBeenCalled();
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending when the Admin API is down", async () => {
    vi.mocked(getFulfillmentOrderOrder).mockRejectedValue(
      new Error("GraphQL Client: Service Unavailable"),
    );

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending when no fulfillment order can be found", async () => {
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue(null);

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending while routing isn't settled", async () => {
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue({
      order: ORDER,
      fulfillmentOrders: [fulfillmentOrder(2, 102, [[11, 2]], "SOMETHING_NEW")],
    });

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when hikyaku-api asks for a retry, 200 when it rejects the event", async () => {
    vi.mocked(getFulfillmentOrderOrder).mockResolvedValue({
      order: ORDER,
      fulfillmentOrders: [fulfillmentOrder(2, 102, [[11, 2]])],
    });
    vi.mocked(postOrderEvent).mockResolvedValueOnce({
      ok: false,
      retry: true,
      detail: "HTTP 503",
    });
    expect((await callAction()).status).toBe(500);

    vi.mocked(postOrderEvent).mockResolvedValueOnce({
      ok: false,
      retry: false,
      detail: "HTTP 400",
    });
    expect((await callAction()).status).toBe(200);
  });
});
