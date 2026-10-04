import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { OrderPaidEvent } from "../lib/order-event.server";
import type {
  ShopifyFulfillmentOrder,
  ShopifyOrder,
} from "../lib/shopify-admin.server";

// importOrders with Shopify and hikyaku-api mocked out: what reaches Hikyaku
// for each picked order, and the outcome the merchant sees.

vi.mock("../shopify.server", () => ({ apiVersion: "2026-07" }));
vi.mock("../lib/hikyaku-api.server", () => ({ postOrderEvent: vi.fn() }));
vi.mock("../lib/shopify-admin.server", () => ({
  getOrder: vi.fn(),
  getOrderFulfillmentOrders: vi.fn(),
}));

const { postOrderEvent } = await import("../lib/hikyaku-api.server");
const { getOrder, getOrderFulfillmentOrders } =
  await import("../lib/shopify-admin.server");
const { importOrders } = await import("../lib/order-import.server");

const SHOP = "example.myshopify.com";
const admin = {} as AdminApiContext;
const money = (amount: string) => ({ shopMoney: { amount } });

function order(id: number, overrides: Partial<ShopifyOrder> = {}) {
  return {
    id: `gid://shopify/Order/${id}`,
    legacyResourceId: String(id),
    name: `#${id}`,
    createdAt: "2026-09-01T00:00:00Z",
    processedAt: "2026-09-01T00:00:00Z",
    currencyCode: "AUD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    closed: false,
    totalPriceSet: money("20.00"),
    subtotalPriceSet: money("20.00"),
    totalTaxSet: null,
    totalWeight: "500",
    note: null,
    tags: [],
    email: null,
    customer: null,
    shippingAddress: {
      address1: "1 Collins St",
      address2: null,
      city: "Melbourne",
      province: "Victoria",
      provinceCode: "VIC",
      zip: "3000",
      country: "Australia",
      countryCodeV2: "AU",
      company: null,
      name: "Ada Lovelace",
      phone: null,
      latitude: null,
      longitude: null,
    },
    shippingLines: { nodes: [] },
    lineItems: [
      {
        id: `gid://shopify/LineItem/${id}1`,
        title: "Coffee",
        variantTitle: null,
        sku: null,
        quantity: 2,
        requiresShipping: true,
        originalUnitPriceSet: money("10.00"),
      },
    ],
    ...overrides,
  } satisfies ShopifyOrder;
}

function fulfillmentOrder(
  orderId: number,
  status = "OPEN",
): ShopifyFulfillmentOrder {
  return {
    id: `gid://shopify/FulfillmentOrder/${orderId}`,
    status,
    assignedLocation: {
      name: "Warehouse",
      location: { id: "gid://shopify/Location/1" },
    },
    deliveryMethod: { methodType: "SHIPPING" },
    lineItems: [
      {
        id: `gid://shopify/FulfillmentOrderLineItem/${orderId}`,
        totalQuantity: 2,
        remainingQuantity: 2,
        lineItem: { id: `gid://shopify/LineItem/${orderId}1` },
        weight: { value: 250, unit: "GRAMS" },
      },
    ],
  };
}

const run = (orderIds: string[]) =>
  importOrders({
    admin,
    shop: SHOP,
    accessToken: "token",
    organisationSlug: "acme",
    orderIds,
  });

/** The events POSTed to Hikyaku, in call order. */
const sent = () =>
  vi
    .mocked(postOrderEvent)
    .mock.calls.map(([, , event]) => event as OrderPaidEvent);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postOrderEvent).mockResolvedValue({ ok: true });
});

describe("importOrders", () => {
  it("sends each order as order.paid, keyed by the order, with its groups", async () => {
    vi.mocked(getOrder).mockImplementation(async (_, id) =>
      order(Number(id.split("/").pop())),
    );
    vi.mocked(getOrderFulfillmentOrders).mockImplementation(async (_, id) => [
      fulfillmentOrder(Number(id.split("/").pop())),
    ]);

    const outcomes = await run([
      "gid://shopify/Order/1",
      "gid://shopify/Order/2",
    ]);

    expect(outcomes).toEqual([
      { orderId: "gid://shopify/Order/1", name: "#1", status: "sent" },
      { orderId: "gid://shopify/Order/2", name: "#2", status: "sent" },
    ]);
    const events = sent();
    expect(events.map((event) => event.event.id).sort()).toEqual([
      "import:gid://shopify/Order/1",
      "import:gid://shopify/Order/2",
    ]);
    const first = events.find(
      (event) => event.order.id === "gid://shopify/Order/1",
    )!;
    expect(first).toMatchObject({
      event: { type: "order.paid", api_version: "2026-07" },
      source: { platform: "shopify", shop_domain: SHOP },
      order: {
        legacy_id: 1,
        line_items: [{ id: "11", quantity: 2, grams: 250 }],
      },
      delivery: { required: true, recipient_name: "Ada Lovelace" },
      fulfillment_groups: [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          external_location_id: "gid://shopify/Location/1",
          line_items: [{ line_item_id: "11", quantity: 2 }],
          total_weight_grams: 500,
        },
      ],
    });
    expect(vi.mocked(postOrderEvent).mock.calls[0].slice(0, 2)).toEqual([
      "token",
      "acme",
    ]);
  });

  it("skips an order cancelled since the list loaded, or with nothing left to deliver", async () => {
    vi.mocked(getOrder)
      .mockResolvedValueOnce(order(1, { cancelledAt: "2026-09-02T00:00:00Z" }))
      .mockResolvedValueOnce(order(2));
    vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
      fulfillmentOrder(2, "CLOSED"),
    ]);

    const outcomes = await run([
      "gid://shopify/Order/1",
      "gid://shopify/Order/2",
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({ name: "#1", status: "skipped" }),
      expect.objectContaining({
        name: "#2",
        status: "skipped",
        reason: "Nothing is left to deliver.",
      }),
    ]);
    expect(postOrderEvent).not.toHaveBeenCalled();
  });

  it("fails an order Shopify can't read, hasn't routed, or Hikyaku refuses", async () => {
    vi.mocked(getOrder)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(order(3))
      .mockResolvedValueOnce(order(4));
    vi.mocked(getOrderFulfillmentOrders)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fulfillmentOrder(4)]);
    vi.mocked(postOrderEvent).mockResolvedValue({
      ok: false,
      retry: false,
      detail: "HTTP 403",
    });

    // One at a time, so the mocks answer in order.
    const outcomes = [];
    for (const id of [1, 2, 3, 4]) {
      outcomes.push(...(await run([`gid://shopify/Order/${id}`])));
    }

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(
      outcomes.map((outcome) => "reason" in outcome && outcome.reason),
    ).toEqual([
      "Couldn't read it from Shopify. Try again.",
      "It no longer exists in Shopify.",
      "Shopify hasn't finished assigning it to a location. Try again in a minute.",
      "Your Hikyaku account isn't allowed to add orders in this organisation.",
    ]);
    expect(postOrderEvent).toHaveBeenCalledTimes(1);
  });

  it("waits and retries when Shopify throttles", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getOrder)
        .mockRejectedValueOnce(new Error("Throttled"))
        .mockResolvedValueOnce(order(1));
      vi.mocked(getOrderFulfillmentOrders).mockResolvedValue([
        fulfillmentOrder(1),
      ]);

      const pending = run(["gid://shopify/Order/1"]);
      await vi.runAllTimersAsync();

      expect(await pending).toEqual([
        { orderId: "gid://shopify/Order/1", name: "#1", status: "sent" },
      ]);
      expect(getOrder).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
