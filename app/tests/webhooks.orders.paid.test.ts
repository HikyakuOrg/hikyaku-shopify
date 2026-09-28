import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { OrderPaidEvent } from "../lib/order-event.server";
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
  getOrderFulfillmentOrders: vi.fn(),
}));

const { authenticate } = await import("../shopify.server");
const { getConnection, getValidAccessToken, postOrderEvent } =
  await import("../lib/hikyaku-api.server");
const { adminForShop, getOrderFulfillmentOrders } =
  await import("../lib/shopify-admin.server");
const { action } = await import("../routes/webhooks.orders.paid");

const SHOP = "example.myshopify.com";

function lineItem(id: number, quantity: number) {
  return {
    id,
    title: `Item ${id}`,
    variant_title: null,
    sku: null,
    quantity,
    price: "10.00",
    grams: 100,
    requires_shipping: true,
  };
}

const payload = {
  id: 1001,
  admin_graphql_api_id: "gid://shopify/Order/1001",
  name: "#1001",
  created_at: "2026-09-28T00:00:00Z",
  processed_at: "2026-09-28T00:00:00Z",
  currency: "AUD",
  financial_status: "paid",
  fulfillment_status: null,
  total_price: "30.00",
  subtotal_price: "30.00",
  total_tax: null,
  total_weight: 300,
  note: null,
  tags: "",
  line_items: [lineItem(11, 2), lineItem(12, 1)],
  shipping_lines: [],
  shipping_address: null,
  customer: null,
};

function fulfillmentOrder(
  id: number,
  locationId: number,
  lineItems: Array<[lineItemId: number, quantity: number]>,
  methodType = "SHIPPING",
): ShopifyFulfillmentOrder {
  return {
    id: `gid://shopify/FulfillmentOrder/${id}`,
    status: "OPEN",
    assignedLocation: {
      name: `Location ${locationId}`,
      location: { id: `gid://shopify/Location/${locationId}` },
    },
    deliveryMethod: { methodType },
    lineItems: lineItems.map(([lineItemId, quantity]) => ({
      id: `gid://shopify/FulfillmentOrderLineItem/${lineItemId}`,
      totalQuantity: quantity,
      remainingQuantity: quantity,
      lineItem: { id: `gid://shopify/LineItem/${lineItemId}` },
      weight: { value: 100, unit: "GRAMS" },
    })),
  };
}

function callAction() {
  return action({
    request: new Request("https://app.example/webhooks/orders/paid", {
      method: "POST",
    }),
  } as ActionFunctionArgs);
}

function postedEvent(): OrderPaidEvent {
  expect(postOrderEvent).toHaveBeenCalledTimes(1);
  return vi.mocked(postOrderEvent).mock.calls[0][2];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(authenticate.webhook).mockResolvedValue({
    shop: SHOP,
    payload,
    webhookId: "webhook-1",
    apiVersion: "2026-07",
    topic: "ORDERS_PAID",
  } as unknown as Awaited<ReturnType<typeof authenticate.webhook>>);
  vi.mocked(getConnection).mockResolvedValue({
    organisationSlug: "acme",
  } as Awaited<ReturnType<typeof getConnection>>);
  vi.mocked(getValidAccessToken).mockResolvedValue("token");
  vi.mocked(adminForShop).mockResolvedValue(
    {} as Awaited<ReturnType<typeof adminForShop>>,
  );
  vi.mocked(postOrderEvent).mockResolvedValue({ ok: true });
});

describe("orders/paid webhook", () => {
  it("sends one event with a group per location", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
      fulfillmentOrder(1, 101, [[11, 2]]),
      fulfillmentOrder(2, 102, [[12, 1]]),
    ]);

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(getOrderFulfillmentOrders).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/1001",
      { signal: expect.any(AbortSignal) },
    );
    const event = postedEvent();
    expect(event.fulfillment_groups).toEqual([
      {
        id: "gid://shopify/FulfillmentOrder/1",
        external_location_id: "gid://shopify/Location/101",
        external_location_name: "Location 101",
        delivery_method: "shipping",
        line_items: [{ line_item_id: "11", quantity: 2 }],
        total_weight_grams: 200,
      },
      {
        id: "gid://shopify/FulfillmentOrder/2",
        external_location_id: "gid://shopify/Location/102",
        external_location_name: "Location 102",
        delivery_method: "shipping",
        line_items: [{ line_item_id: "12", quantity: 1 }],
        total_weight_grams: 100,
      },
    ]);
    // Every group line item names an order line item, as the API requires.
    const orderLineItemIds = event.order.line_items.map((item) => item.id);
    for (const group of event.fulfillment_groups) {
      for (const item of group.line_items) {
        expect(orderLineItemIds).toContain(item.line_item_id);
      }
    }
  });

  it("sends a pickup order as a pickup group", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
      fulfillmentOrder(
        1,
        101,
        [
          [11, 2],
          [12, 1],
        ],
        "PICK_UP",
      ),
    ]);

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(postedEvent().fulfillment_groups).toMatchObject([
      { delivery_method: "pickup" },
    ]);
  });

  it("returns 500 without sending when the Admin API is down", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockRejectedValue(
      new Error("GraphQL Client: Service Unavailable"),
    );

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending when the Admin API is too slow", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockImplementation(
      (_admin, _orderId, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          );
        }),
    );

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending while routing isn't finished", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([]);

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 without sending when the order isn't found", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue(null);

    const response = await callAction();

    expect(response.status).toBe(500);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("sends nothing when every fulfillment order is already fulfilled", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
      {
        ...fulfillmentOrder(1, 101, [
          [11, 2],
          [12, 1],
        ]),
        status: "CLOSED",
      },
    ]);

    const response = await callAction();

    expect(response.status).toBe(200);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("returns 500 when hikyaku-api asks for a retry", async () => {
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
      fulfillmentOrder(1, 101, [
        [11, 2],
        [12, 1],
      ]),
    ]);
    vi.mocked(postOrderEvent).mockResolvedValue({
      ok: false,
      retry: true,
      detail: "HTTP 503",
    });

    const response = await callAction();

    expect(response.status).toBe(500);
  });
});
