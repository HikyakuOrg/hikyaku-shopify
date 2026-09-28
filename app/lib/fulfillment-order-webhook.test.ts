import { describe, expect, it } from "vitest";
import {
  fulfillmentOrderGid,
  readFulfillmentOrderChange,
} from "./fulfillment-order-webhook";

const fo = (n: number) => `gid://shopify/FulfillmentOrder/${n}`;

// Payloads as in Shopify's webhook reference.
describe("readFulfillmentOrderChange", () => {
  it("releases the fulfillment order a move took items from", () => {
    expect(
      readFulfillmentOrderChange("FULFILLMENT_ORDERS_MOVED", {
        original_fulfillment_order: {
          id: fo(1),
          status: "closed",
        },
        moved_fulfillment_order: { id: fo(2), status: "open" },
      }),
    ).toEqual({ releasedIds: [fo(1)], lookupIds: [fo(2), fo(1)] });
  });

  it("releases nothing new for a move that kept the same fulfillment order", () => {
    // Moved whole: the id stays, and Hikyaku sees its new location.
    expect(
      readFulfillmentOrderChange("fulfillment_orders/moved", {
        original_fulfillment_order: { id: fo(1), status: "open" },
        moved_fulfillment_order: { id: fo(1), status: "open" },
      }),
    ).toEqual({ releasedIds: [fo(1)], lookupIds: [fo(1)] });
  });

  it("releases a split's original and looks up through its new parts first", () => {
    expect(
      readFulfillmentOrderChange("FULFILLMENT_ORDERS_SPLIT", {
        fulfillment_order: { id: fo(1), status: "open" },
        remaining_fulfillment_order: { id: fo(2), status: "open" },
        replacement_fulfillment_order: { id: fo(3), status: "open" },
      }),
    ).toEqual({
      releasedIds: [fo(1)],
      lookupIds: [fo(2), fo(3), fo(1)],
    });
  });

  it("releases every merged fulfillment order, given as bare numbers", () => {
    expect(
      readFulfillmentOrderChange("FULFILLMENT_ORDERS_MERGED", {
        merge_intents: [
          { fulfillment_order_id: 1 },
          { fulfillment_order_id: 2 },
        ],
        fulfillment_order_merges: {
          fulfillment_order: { id: fo(1), status: "open" },
        },
      }),
    ).toEqual({ releasedIds: [fo(1), fo(2)], lookupIds: [fo(1), fo(2)] });
  });

  it("reads fulfillment_order_merges as a list too", () => {
    expect(
      readFulfillmentOrderChange("FULFILLMENT_ORDERS_MERGED", {
        merge_intents: [{ fulfillment_order_id: "7" }],
        fulfillment_order_merges: [{ fulfillment_order: { id: fo(9) } }],
      }).lookupIds,
    ).toEqual([fo(9), fo(7)]);
  });

  it("releases a cancelled fulfillment order and looks up through its replacement", () => {
    expect(
      readFulfillmentOrderChange("FULFILLMENT_ORDERS_CANCELLED", {
        fulfillment_order: { id: fo(1), status: "cancelled" },
        replacement_fulfillment_order: { id: fo(2), status: "open" },
      }),
    ).toEqual({ releasedIds: [fo(1)], lookupIds: [fo(2), fo(1)] });
  });

  it("releases nothing when a scheduled fulfillment order comes due", () => {
    for (const topic of [
      "FULFILLMENT_ORDERS_SCHEDULED_FULFILLMENT_ORDER_READY",
      "fulfillment_orders/scheduled_fulfillment_order_ready",
    ]) {
      expect(
        readFulfillmentOrderChange(topic, {
          fulfillment_order: { id: fo(5), status: "open" },
        }),
      ).toEqual({ releasedIds: [], lookupIds: [fo(5)] });
    }
  });

  it("finds nothing in a payload without fulfillment orders", () => {
    expect(readFulfillmentOrderChange("FULFILLMENT_ORDERS_MOVED", {})).toEqual({
      releasedIds: [],
      lookupIds: [],
    });
  });
});

describe("fulfillmentOrderGid", () => {
  it("turns a bare number into a GID and leaves a GID alone", () => {
    expect(fulfillmentOrderGid(12)).toBe(fo(12));
    expect(fulfillmentOrderGid(" 12 ")).toBe(fo(12));
    expect(fulfillmentOrderGid(fo(3))).toBe(fo(3));
  });
});
