/**
 * Home screen banner while paid orders from before the store was connected
 * aren't in Hikyaku yet.
 */
export function EarlierOrdersBanner({
  count,
  more,
}: {
  count: number;
  /** Shopify has more such orders than were checked. */
  more: boolean;
}) {
  const orders = `${count}${more ? "+" : ""} ${count === 1 && !more ? "order" : "orders"}`;
  return (
    <s-banner heading="Earlier orders aren't in Hikyaku" tone="info">
      {count === 1 && !more
        ? "1 paid order from before this store was connected to Hikyaku is still waiting to ship. Choose whether Hikyaku should deliver it."
        : `${orders} paid before this store was connected to Hikyaku are still waiting to ship. Choose which Hikyaku should deliver.`}
      <s-button slot="secondary-actions" href="/app/orders">
        Choose orders
      </s-button>
    </s-banner>
  );
}
