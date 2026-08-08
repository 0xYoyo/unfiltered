/**
 * Price display for result cards (YOY-48 AC-3): formatted with the currency
 * code, deliberately not Intl currency symbols — deterministic across
 * browsers and exactly what the spec names. A range renders when the
 * product's variants span prices.
 */
/**
 * Shopper-facing display text for one applied-constraint chip (YOY-49
 * AC-1). English only (NG-2); values render as the engine extracted them.
 */
export function chipLabel(chip: { field: string; value: string }): string {
  switch (chip.field) {
    case "priceMin":
      return `Over ${chip.value}`;
    case "priceMax":
      return `Under ${chip.value}`;
    case "colorsExclude":
      return `Not ${chip.value}`;
    case "availability":
      return "In stock";
    default:
      // category, colorsInclude, occasion: the value speaks for itself.
      return chip.value;
  }
}

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
