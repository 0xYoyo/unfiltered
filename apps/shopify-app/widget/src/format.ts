/**
 * Price display for result cards (YOY-48 AC-3): formatted with the currency
 * code, deliberately not Intl currency symbols — deterministic across
 * browsers and exactly what the spec names. A range renders when the
 * product's variants span prices.
 */
export function formatPrice(
  priceMin: number,
  priceMax: number,
  currencyCode: string,
): string {
  const amount = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(2);
  return priceMin === priceMax
    ? `${amount(priceMin)} ${currencyCode}`
    : `${amount(priceMin)}–${amount(priceMax)} ${currencyCode}`;
}
