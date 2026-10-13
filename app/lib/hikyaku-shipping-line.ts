// Pure: finds the Hikyaku rate an order was charged for among its shipping
// lines (HIK-212). With Hikyaku rates on, only orders that chose one are sent
// to Hikyaku, and the order.paid event says which service and price.

/** Every Hikyaku rate code starts with this, on both paths. */
export const RATE_CODE_PREFIX = "hikyaku:";

export type RatePath = "live" | "static";

/**
 * A rate code: `hikyaku:<service_id>` (live, or a static flat rate),
 * `hikyaku:<service_id>:d:<min>-<max>` (a static distance band, in the
 * service's unit) or `hikyaku:<service_id>:w:<min_grams>-<max_grams>` (a
 * static weight band).
 */
export interface RateCode {
  serviceId: string;
  band: { kind: "distance" | "weight"; min: number; max: number } | null;
}

export function parseRateCode(
  code: string | null | undefined,
): RateCode | null {
  if (!code || !code.startsWith(RATE_CODE_PREFIX)) return null;
  const [serviceId, kind, range, ...rest] = code
    .slice(RATE_CODE_PREFIX.length)
    .split(":");
  if (!serviceId || rest.length > 0) return null;
  if (kind === undefined) return { serviceId, band: null };
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(range ?? "");
  if ((kind !== "d" && kind !== "w") || !match) return null;
  return {
    serviceId,
    band: {
      kind: kind === "d" ? "distance" : "weight",
      min: Number(match[1]),
      max: Number(match[2]),
    },
  };
}

interface MoneySet {
  shop_money?: { amount: string; currency_code: string } | null;
}

/** The fields of an orders/paid (REST) shipping line this reads. */
export interface PayloadShippingLine {
  title: string;
  price: string;
  code?: string | null;
  source?: string | null;
  carrier_identifier?: string | null;
  discounted_price?: string | null;
  price_set?: MoneySet | null;
  discounted_price_set?: MoneySet | null;
}

/** What order.paid's `shipping_rate` carries. */
export interface ShippingRateChoice {
  service_id: string;
  path: RatePath;
  /** Shop currency, before discounts. */
  price: string;
  /** Shop currency, what the shopper paid for it. */
  discounted_price: string;
  currency: string;
  title: string;
}

/**
 * The order's Hikyaku shipping line, or null if it chose another rate.
 *
 * A live rate comes from the carrier service, whose `service_code` is a rate
 * code, and Shopify copies that into the line's `code`. A static rate is one
 * of the method definitions the app wrote into the shop's delivery profiles:
 * its line carries the method's name, which `staticRates` maps back to the
 * rate code the app wrote it for.
 *
 * @param shopCurrency Used when a line has no `price_set`.
 * @param staticRates Name of each Hikyaku method definition → its rate code.
 */
export function findHikyakuShippingLine(
  lines: PayloadShippingLine[],
  options: { shopCurrency: string; staticRates?: ReadonlyMap<string, string> },
): ShippingRateChoice | null {
  for (const line of lines) {
    const staticCode = parseRateCode(
      (line.code && options.staticRates?.get(line.code)) ||
        options.staticRates?.get(line.title),
    );
    const code = staticCode ?? parseRateCode(line.code);
    if (!code) continue;
    const path: RatePath = staticCode ? "static" : "live";
    const price = line.price_set?.shop_money?.amount ?? line.price;
    return {
      service_id: code.serviceId,
      path,
      price,
      discounted_price:
        line.discounted_price_set?.shop_money?.amount ??
        line.discounted_price ??
        price,
      currency:
        line.price_set?.shop_money?.currency_code ?? options.shopCurrency,
      title: line.title,
    };
  }
  return null;
}
