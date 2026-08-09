import {
  HEBREW_AVAILABILITY_DISPLAY,
  HEBREW_CATEGORY_DISPLAY,
  HEBREW_COLOR_DISPLAY,
  HEBREW_OCCASION_DISPLAY,
  type WidgetLocale,
} from "./strings";

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

/** Display context for chip labels (YOY-50 AC-4). */
export interface ChipDisplayContext {
  locale: WidgetLocale;
  /** Currency code from the response's echoed intent, when present. */
  currency?: string;
}

/**
 * Shopper-facing display text for one applied-constraint chip (YOY-49 AC-1,
 * localized for Hebrew chrome by YOY-50 AC-4). English labels stay exactly
 * as YOY-49 shipped them. Hebrew price chips carry the currency, canonical
 * taxonomy values (categories, occasions, availability, common colors) get
 * Hebrew display strings, and anything outside those sets renders as
 * extracted — display-only; the chip's wire value is untouched (NG-3).
 */
export function chipLabel(
  chip: { field: string; value: string },
  context: ChipDisplayContext = { locale: "en" },
): string {
  if (context.locale === "he") {
    const priceAmount =
      context.currency === undefined
        ? chip.value
        : `${chip.value} ${context.currency}`;
    switch (chip.field) {
      case "priceMin":
        return `מעל ${priceAmount}`;
      case "priceMax":
        return `עד ${priceAmount}`;
      case "colorsExclude":
        return `לא ${HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value}`;
      case "colorsInclude":
        return HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value;
      case "availability":
        return HEBREW_AVAILABILITY_DISPLAY;
      case "category":
        return HEBREW_CATEGORY_DISPLAY[chip.value] ?? chip.value;
      case "occasion":
        return HEBREW_OCCASION_DISPLAY[chip.value] ?? chip.value;
      default:
        return chip.value;
    }
  }
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
