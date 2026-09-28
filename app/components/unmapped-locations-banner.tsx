/** Home screen banner while active locations are still unmapped. */
export function UnmappedLocationsBanner({ count }: { count: number }) {
  return (
    <s-banner heading="Locations need mapping" tone="warning">
      {count === 1
        ? "1 location isn't mapped. Orders shipped from it will need attention in Hikyaku."
        : `${count} locations aren't mapped. Orders shipped from them will need attention in Hikyaku.`}
      <s-button slot="secondary-actions" href="/app/locations">
        Map locations
      </s-button>
    </s-banner>
  );
}
