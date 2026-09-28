// Reads the fulfillment_orders/moved, split, merged, cancelled and
// scheduled_fulfillment_order_ready webhook payloads: which fulfillment
// orders the change released items from, and which ones can be used to find
// the order. Pure, no I/O, so it is unit tested; the handler is
// app/routes/webhooks.fulfillment_orders.tsx.

interface FulfillmentOrderRef {
  id?: string | null;
  status?: string | null;
}

/** The fields of the four payloads this app reads. Everything else is ignored. */
export interface FulfillmentOrderWebhookPayload {
  // moved
  original_fulfillment_order?: FulfillmentOrderRef | null;
  moved_fulfillment_order?: FulfillmentOrderRef | null;
  // split and cancelled
  fulfillment_order?: FulfillmentOrderRef | null;
  // split
  remaining_fulfillment_order?: FulfillmentOrderRef | null;
  // split and cancelled
  replacement_fulfillment_order?: FulfillmentOrderRef | null;
  // merged: the fulfillment orders that were merged, by numeric id
  merge_intents?: Array<{ fulfillment_order_id?: number | string | null }>;
  // merged: the result. Shopify's example shows an object, older docs a list.
  fulfillment_order_merges?:
    | { fulfillment_order?: FulfillmentOrderRef | null }
    | Array<{ fulfillment_order?: FulfillmentOrderRef | null }>
    | null;
}

export interface FulfillmentOrderChange {
  /**
   * The fulfillment orders the change took items away from: the one moved
   * out of, the one split, those merged, the one cancelled. Hikyaku drops the
   * package of any of them that's no longer among the order's groups, so
   * listing one that's still open (a split keeps its original) is harmless.
   */
  releasedIds: string[];
  /**
   * Every fulfillment order the payload names, the ones most likely to
   * still exist first (a move's destination, a split's new parts, a merge's
   * result), for looking up the order they belong to.
   */
  lookupIds: string[];
}

const FULFILLMENT_ORDER_GID = "gid://shopify/FulfillmentOrder/";

const SCHEDULED_READY = "FULFILLMENT_ORDERS_SCHEDULED_FULFILLMENT_ORDER_READY";

function normaliseTopic(topic: string): string {
  return topic.trim().toUpperCase().replace(/\//g, "_");
}

/** A fulfillment order id as a GID; merge_intents carries bare numbers. */
export function fulfillmentOrderGid(id: number | string): string {
  const value = String(id).trim();
  return /^\d+$/.test(value) ? `${FULFILLMENT_ORDER_GID}${value}` : value;
}

/**
 * @param topic The webhook topic, as `authenticate.webhook` gives it
 * (`FULFILLMENT_ORDERS_MOVED`) or as subscribed (`fulfillment_orders/moved`).
 */
export function readFulfillmentOrderChange(
  topic: string,
  payload: FulfillmentOrderWebhookPayload,
): FulfillmentOrderChange {
  // A scheduled fulfillment order coming due takes nothing from anywhere: it
  // only adds a group to deliver.
  if (normaliseTopic(topic) === SCHEDULED_READY) {
    return {
      releasedIds: [],
      lookupIds: unique([payload.fulfillment_order?.id]),
    };
  }

  const merges = payload.fulfillment_order_merges;
  const merged = (Array.isArray(merges) ? merges : merges ? [merges] : []).map(
    (merge) => merge.fulfillment_order?.id,
  );
  const mergedFrom = (payload.merge_intents ?? []).map((intent) =>
    intent.fulfillment_order_id == null
      ? null
      : fulfillmentOrderGid(intent.fulfillment_order_id),
  );

  const released = [
    payload.original_fulfillment_order?.id,
    payload.fulfillment_order?.id,
    ...mergedFrom,
  ];
  const created = [
    payload.moved_fulfillment_order?.id,
    payload.remaining_fulfillment_order?.id,
    payload.replacement_fulfillment_order?.id,
    ...merged,
  ];

  return {
    releasedIds: unique(released),
    lookupIds: unique([...created, ...released]),
  };
}

function unique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
