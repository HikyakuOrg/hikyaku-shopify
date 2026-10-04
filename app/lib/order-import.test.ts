import { describe, expect, it } from "vitest";
import {
  importEventId,
  importableOrdersSearch,
  notImportableReason,
  orderPaidPayloadFromOrder,
} from "./order-import";
import type {
  ShopifyFulfillmentOrder,
  ShopifyOrder,
} from "./shopify-admin.server";

const money = (amount: string) => ({ shopMoney: { amount } });

function order(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/1001",
    legacyResourceId: "1001",
    name: "#1001",
    createdAt: "2026-09-01T00:00:00Z",
    processedAt: "2026-09-01T00:05:00Z",
    currencyCode: "AUD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    closed: false,
    totalPriceSet: money("45.00"),
    subtotalPriceSet: money("35.00"),
    totalTaxSet: money("4.09"),
    totalWeight: "1200",
    note: "Leave at the door",
    tags: ["vip", "local"],
    email: "order@example.com",
    customer: {
      legacyResourceId: "77",
      firstName: "Ada",
      lastName: "Lovelace",
      defaultEmailAddress: { emailAddress: "ada@example.com" },
      defaultPhoneNumber: { phoneNumber: "+61400000000" },
    },
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
      phone: "+61411111111",
      latitude: null,
      longitude: null,
    },
    shippingLines: {
      nodes: [
        { title: "Local delivery", originalPriceSet: money("7.50") },
        { title: "Surcharge", originalPriceSet: money("2.50") },
      ],
    },
    lineItems: [
      {
        id: "gid://shopify/LineItem/11",
        title: "Coffee",
        variantTitle: "1 kg",
        sku: "COF-1",
        quantity: 2,
        requiresShipping: true,
        originalUnitPriceSet: money("15.00"),
      },
      {
        id: "gid://shopify/LineItem/12",
        title: "Gift card",
        variantTitle: null,
        sku: null,
        quantity: 1,
        requiresShipping: false,
        originalUnitPriceSet: money("5.00"),
      },
    ],
    ...overrides,
  };
}

const fulfillmentOrders: ShopifyFulfillmentOrder[] = [
  {
    id: "gid://shopify/FulfillmentOrder/1",
    status: "OPEN",
    assignedLocation: {
      name: "Warehouse",
      location: { id: "gid://shopify/Location/1" },
    },
    deliveryMethod: { methodType: "SHIPPING" },
    lineItems: [
      {
        id: "gid://shopify/FulfillmentOrderLineItem/1",
        totalQuantity: 2,
        remainingQuantity: 2,
        lineItem: { id: "gid://shopify/LineItem/11" },
        weight: { value: 1.2, unit: "KILOGRAMS" },
      },
    ],
  },
];

describe("importableOrdersSearch", () => {
  it("asks for open, paid orders still to ship", () => {
    expect(importableOrdersSearch()).toBe(
      "status:open financial_status:paid,partially_refunded fulfillment_status:unshipped,unfulfilled,partial,on_hold",
    );
  });

  it("can keep to orders paid before a time", () => {
    expect(
      importableOrdersSearch(new Date("2026-09-29T10:39:21.000Z")),
    ).toMatch(/ processed_at:<'2026-09-29T10:39:21\.000Z'$/);
  });
});

describe("notImportableReason", () => {
  it("accepts an open, paid order", () => {
    expect(notImportableReason(order())).toBeNull();
    expect(
      notImportableReason(
        order({ displayFinancialStatus: "PARTIALLY_REFUNDED" }),
      ),
    ).toBeNull();
  });

  it("refuses a cancelled, archived or unpaid order", () => {
    expect(
      notImportableReason(order({ cancelledAt: "2026-09-02T00:00:00Z" })),
    ).toMatch(/cancelled/);
    expect(notImportableReason(order({ closed: true }))).toMatch(/archived/);
    expect(
      notImportableReason(order({ displayFinancialStatus: "REFUNDED" })),
    ).toMatch(/paid/);
    expect(
      notImportableReason(order({ displayFinancialStatus: null })),
    ).toMatch(/paid/);
  });
});

describe("importEventId", () => {
  it("is the same for every import of an order", () => {
    expect(importEventId("gid://shopify/Order/1001")).toBe(
      "import:gid://shopify/Order/1001",
    );
  });
});

describe("orderPaidPayloadFromOrder", () => {
  it("gives the orders/paid payload shape", () => {
    const payload = orderPaidPayloadFromOrder(order(), fulfillmentOrders);

    expect(payload).toEqual({
      id: 1001,
      admin_graphql_api_id: "gid://shopify/Order/1001",
      name: "#1001",
      created_at: "2026-09-01T00:00:00Z",
      processed_at: "2026-09-01T00:05:00Z",
      currency: "AUD",
      financial_status: "paid",
      fulfillment_status: null,
      total_price: "45.00",
      subtotal_price: "35.00",
      total_tax: "4.09",
      total_weight: 1200,
      note: "Leave at the door",
      tags: "vip, local",
      line_items: [
        {
          id: 11,
          title: "Coffee",
          variant_title: "1 kg",
          sku: "COF-1",
          quantity: 2,
          price: "15.00",
          grams: 1200,
          requires_shipping: true,
        },
        {
          id: 12,
          title: "Gift card",
          variant_title: null,
          sku: null,
          quantity: 1,
          price: "5.00",
          grams: 0,
          requires_shipping: false,
        },
      ],
      shipping_lines: [
        { title: "Local delivery", price: "7.50" },
        { title: "Surcharge", price: "2.50" },
      ],
      shipping_address: {
        address1: "1 Collins St",
        address2: null,
        city: "Melbourne",
        province: "Victoria",
        province_code: "VIC",
        zip: "3000",
        country: "Australia",
        country_code: "AU",
        company: null,
        name: "Ada Lovelace",
        phone: "+61411111111",
        latitude: null,
        longitude: null,
      },
      customer: {
        id: 77,
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone: "+61400000000",
      },
    });
  });

  it("maps fulfillment statuses to orders/paid's names", () => {
    const status = (displayFulfillmentStatus: string) =>
      orderPaidPayloadFromOrder(order({ displayFulfillmentStatus }), [])
        .fulfillment_status;

    expect(status("PARTIALLY_FULFILLED")).toBe("partial");
    expect(status("ON_HOLD")).toBe("on_hold");
  });

  it("copes with no customer, address, weight or tax", () => {
    const payload = orderPaidPayloadFromOrder(
      order({
        customer: null,
        shippingAddress: null,
        totalWeight: null,
        totalTaxSet: null,
        subtotalPriceSet: null,
        tags: [],
      }),
      [],
    );

    expect(payload).toMatchObject({
      customer: null,
      shipping_address: null,
      total_weight: null,
      total_tax: null,
      subtotal_price: null,
      tags: "",
    });
  });

  it("falls back to the order's email for a customer without one", () => {
    const payload = orderPaidPayloadFromOrder(
      order({
        customer: {
          legacyResourceId: "77",
          firstName: null,
          lastName: null,
          defaultEmailAddress: null,
          defaultPhoneNumber: null,
        },
      }),
      [],
    );

    expect(payload.customer).toMatchObject({
      email: "order@example.com",
      phone: null,
    });
  });
});
