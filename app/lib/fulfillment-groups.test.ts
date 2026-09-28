import { describe, expect, it } from "vitest";
import {
  buildFulfillmentGroups,
  deliveryMethod,
  legacyId,
  weightInGrams,
} from "./fulfillment-groups";
import type { ShopifyFulfillmentOrder } from "./shopify-admin.server";

function lineItem(
  id: number,
  quantity: number,
  weight: { value: number; unit: string } | null = {
    value: 100,
    unit: "GRAMS",
  },
  remainingQuantity = quantity,
) {
  return {
    id: `gid://shopify/FulfillmentOrderLineItem/${id}0`,
    totalQuantity: quantity,
    remainingQuantity,
    lineItem: { id: `gid://shopify/LineItem/${id}` },
    weight,
  };
}

function fulfillmentOrder(
  id: number,
  overrides: Partial<ShopifyFulfillmentOrder> = {},
): ShopifyFulfillmentOrder {
  return {
    id: `gid://shopify/FulfillmentOrder/${id}`,
    status: "OPEN",
    assignedLocation: {
      name: `Location ${id}`,
      location: { id: `gid://shopify/Location/${id}` },
    },
    deliveryMethod: { methodType: "SHIPPING" },
    lineItems: [lineItem(1, 1)],
    ...overrides,
  };
}

const ORDER_LINE_ITEMS = ["1", "2", "3"];

describe("legacyId", () => {
  it("takes the numeric id off a GID", () => {
    expect(legacyId("gid://shopify/LineItem/123")).toBe("123");
    expect(legacyId("gid://shopify/LineItem/123?foo=bar")).toBe("123");
  });

  it("leaves anything else alone", () => {
    expect(legacyId("123")).toBe("123");
    expect(legacyId("gid://shopify/LineItem/abc")).toBe(
      "gid://shopify/LineItem/abc",
    );
  });
});

describe("deliveryMethod", () => {
  it("maps Shopify's method types", () => {
    expect(deliveryMethod("SHIPPING")).toBe("shipping");
    expect(deliveryMethod("LOCAL")).toBe("local");
    expect(deliveryMethod("PICK_UP")).toBe("pickup");
  });

  it("treats anything else as none", () => {
    expect(deliveryMethod("NONE")).toBe("none");
    expect(deliveryMethod("RETAIL")).toBe("none");
    expect(deliveryMethod("PICKUP_POINT")).toBe("none");
    expect(deliveryMethod(null)).toBe("none");
  });
});

describe("weightInGrams", () => {
  it("converts each unit", () => {
    expect(weightInGrams({ value: 250, unit: "GRAMS" })).toBe(250);
    expect(weightInGrams({ value: 1.5, unit: "KILOGRAMS" })).toBe(1500);
    expect(weightInGrams({ value: 1, unit: "POUNDS" })).toBeCloseTo(453.59);
    expect(weightInGrams({ value: 1, unit: "OUNCES" })).toBeCloseTo(28.35);
  });

  it("is null for an unknown unit", () => {
    expect(weightInGrams({ value: 1, unit: "STONES" })).toBeNull();
  });
});

describe("buildFulfillmentGroups", () => {
  it("makes one group per location with its own line items", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1, { lineItems: [lineItem(1, 2), lineItem(2, 1)] }),
        fulfillmentOrder(2, { lineItems: [lineItem(3, 4)] }),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(result).toEqual({
      ok: true,
      groups: [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          external_location_id: "gid://shopify/Location/1",
          external_location_name: "Location 1",
          delivery_method: "shipping",
          line_items: [
            { line_item_id: "1", quantity: 2 },
            { line_item_id: "2", quantity: 1 },
          ],
          total_weight_grams: 300,
        },
        {
          id: "gid://shopify/FulfillmentOrder/2",
          external_location_id: "gid://shopify/Location/2",
          external_location_name: "Location 2",
          delivery_method: "shipping",
          line_items: [{ line_item_id: "3", quantity: 4 }],
          total_weight_grams: 400,
        },
      ],
      skipped: [],
      unknownLineItemIds: [],
    });
  });

  it("keeps a pickup group, with its delivery method", () => {
    const result = buildFulfillmentGroups(
      [fulfillmentOrder(1, { deliveryMethod: { methodType: "PICK_UP" } })],
      ORDER_LINE_ITEMS,
    );
    expect(result.ok && result.groups[0].delivery_method).toBe("pickup");
  });

  it("splits a line item across locations by quantity", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1, { lineItems: [lineItem(1, 2)] }),
        fulfillmentOrder(2, { lineItems: [lineItem(1, 3)] }),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(result.ok && result.groups.map((group) => group.line_items)).toEqual(
      [
        [{ line_item_id: "1", quantity: 2 }],
        [{ line_item_id: "1", quantity: 3 }],
      ],
    );
  });

  it("counts only the units still to fulfill", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1, {
          status: "IN_PROGRESS",
          lineItems: [
            lineItem(1, 3, undefined, 1),
            lineItem(2, 2, undefined, 0),
          ],
        }),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(result.ok && result.groups[0]).toMatchObject({
      line_items: [{ line_item_id: "1", quantity: 1 }],
      total_weight_grams: 100,
    });
  });

  it("converts and rounds weights, or leaves them null when one is missing", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1, {
          lineItems: [
            lineItem(1, 2, { value: 1, unit: "OUNCES" }),
            lineItem(2, 1, { value: 0.5, unit: "KILOGRAMS" }),
          ],
        }),
        fulfillmentOrder(2, {
          lineItems: [lineItem(3, 1), lineItem(1, 1, null)],
        }),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(
      result.ok && result.groups.map((group) => group.total_weight_grams),
    ).toEqual([557, null]);
  });

  it("keeps an on-hold fulfillment order", () => {
    const result = buildFulfillmentGroups(
      [fulfillmentOrder(1, { status: "ON_HOLD" })],
      ORDER_LINE_ITEMS,
    );
    expect(result.ok && result.groups.map((group) => group.id)).toEqual([
      "gid://shopify/FulfillmentOrder/1",
    ]);
  });

  it("skips fulfillment orders with nothing to deliver now", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1, { status: "CLOSED" }),
        fulfillmentOrder(2, { status: "CANCELLED" }),
        fulfillmentOrder(3, { status: "SCHEDULED" }),
        fulfillmentOrder(4, { lineItems: [lineItem(1, 1, undefined, 0)] }),
        fulfillmentOrder(5),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(result).toMatchObject({
      ok: true,
      groups: [{ id: "gid://shopify/FulfillmentOrder/5" }],
      skipped: [
        { id: "gid://shopify/FulfillmentOrder/1", status: "CLOSED" },
        { id: "gid://shopify/FulfillmentOrder/2", status: "CANCELLED" },
        { id: "gid://shopify/FulfillmentOrder/3", status: "SCHEDULED" },
        { id: "gid://shopify/FulfillmentOrder/4", status: "OPEN" },
      ],
    });
  });

  it("returns no groups when every fulfillment order is done", () => {
    const result = buildFulfillmentGroups(
      [fulfillmentOrder(1, { status: "CLOSED" })],
      ORDER_LINE_ITEMS,
    );
    expect(result).toMatchObject({ ok: true, groups: [] });
  });

  it("leaves out line items the order doesn't list", () => {
    const result = buildFulfillmentGroups(
      [fulfillmentOrder(1, { lineItems: [lineItem(1, 1), lineItem(9, 1)] })],
      ORDER_LINE_ITEMS,
    );
    expect(result).toMatchObject({
      ok: true,
      groups: [{ line_items: [{ line_item_id: "1", quantity: 1 }] }],
      unknownLineItemIds: ["9"],
    });
  });

  it("fails while the order has no fulfillment orders", () => {
    expect(buildFulfillmentGroups([], ORDER_LINE_ITEMS).ok).toBe(false);
  });

  it("fails for a deliverable fulfillment order without a location", () => {
    const result = buildFulfillmentGroups(
      [
        fulfillmentOrder(1),
        fulfillmentOrder(2, {
          assignedLocation: { name: "Gone", location: null },
        }),
      ],
      ORDER_LINE_ITEMS,
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "fulfillment order gid://shopify/FulfillmentOrder/2 has no assigned location",
    });
  });

  it("fails for a status it doesn't know", () => {
    const result = buildFulfillmentGroups(
      [fulfillmentOrder(1, { status: "SOMETHING_NEW" })],
      ORDER_LINE_ITEMS,
    );
    expect(result.ok).toBe(false);
  });
});
