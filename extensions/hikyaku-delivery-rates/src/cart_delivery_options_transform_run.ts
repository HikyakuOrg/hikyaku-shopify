import { decide, type Operation } from "./hikyaku-rates";

// The Function's entry point: reads the input query
// (cart_delivery_options_transform_run.graphql) into hikyaku-rates.ts's
// decide, which holds all the logic.

interface RunInput {
  presentmentCurrencyRate: string | number | null;
  cart: {
    cost: { totalAmount: { currencyCode: string } };
    deliveryGroups: Array<{
      deliveryAddress: {
        latitude: number | null;
        longitude: number | null;
      } | null;
      deliveryOptions: Array<{
        handle: string;
        title: string | null;
        code: string | null;
        cost: { amount: string | number };
      }>;
    }>;
  };
  deliveryCustomization: {
    coverage: { jsonValue: unknown } | null;
    rates: { jsonValue: unknown } | null;
  };
}

export function cartDeliveryOptionsTransformRun(input: RunInput): {
  operations: Operation[];
} {
  return {
    operations: decide({
      currency: input.cart.cost.totalAmount.currencyCode,
      presentmentCurrencyRate: input.presentmentCurrencyRate,
      groups: input.cart.deliveryGroups,
      rates: input.deliveryCustomization.rates?.jsonValue ?? null,
      coverage: input.deliveryCustomization.coverage?.jsonValue ?? null,
    }),
  };
}
