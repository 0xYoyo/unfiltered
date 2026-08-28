import {
  HEBREW_ATTRIBUTE_DISPLAY,
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
 * A negated attribute (YOY-133) reads "Not wool" / "לא צמר", exactly the
 * colour-exclusion shape; a required category-like attribute reads its
 * word ("bridal" / "כלה").
 *
 * The joined string; `chipLabelParts` is the same label with the negator
 * kept separate, for surfaces that mark an exclusion typographically.
 */
export function chipLabel(
  chip: { field: string; value: string },
  context: ChipDisplayContext = { locale: "en" },
): string {
  const { negator, value } = chipLabelParts(chip, context);
  return negator === null ? value : `${negator} ${value}`;
}

/**
 * The constraint fields whose chips are EXCLUSIONS. One list, shared by
 * every surface that draws a chip: "not black" and "black" are opposite
 * instructions, and a surface that cannot tell them apart cannot mark the
 * difference (P-9, W-7).
 */
export const NEGATION_CHIP_FIELDS: ReadonlySet<string> = new Set([
  "colorsExclude",
  "attributesExclude",
]);

export function isNegationChip(chip: { field: string }): boolean {
  return NEGATION_CHIP_FIELDS.has(chip.field);
}

/**
 * One chip's label split at the negator: `{ negator: "Not", value: "black" }`
 * for an exclusion, `{ negator: null, value: "dress" }` otherwise.
 *
 * The widget marks an exclusion by striking the excluded VALUE and leaving
 * the negator upright — "Not b̶l̶a̶c̶k̶" — because striking the whole label
 * would read as the negation of the negation. It cannot mark it the way the
 * playground does (an accent tint), because W-3 forbids the widget a hue
 * the host page does not already have; weight and this strike are the
 * achromatic means available.
 */
export interface ChipLabelParts {
  /** The exclusion word, or null when the chip is an inclusion. */
  negator: string | null;
  /** The constrained value, in the chrome language's display form. */
  value: string;
}

export function chipLabelParts(
  chip: { field: string; value: string },
  context: ChipDisplayContext = { locale: "en" },
): ChipLabelParts {
  if (context.locale === "he") {
    const priceAmount =
      context.currency === undefined
        ? chip.value
        : `${chip.value} ${context.currency}`;
    switch (chip.field) {
      case "priceMin":
        return bare(`מעל ${priceAmount}`);
      case "priceMax":
        return bare(`עד ${priceAmount}`);
      case "colorsExclude":
        return {
          negator: "לא",
          value: HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value,
        };
      case "colorsInclude":
        return bare(HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value);
      case "attributesExclude":
        return {
          negator: "לא",
          value: HEBREW_ATTRIBUTE_DISPLAY[chip.value] ?? chip.value,
        };
      case "attributesInclude":
        return bare(HEBREW_ATTRIBUTE_DISPLAY[chip.value] ?? chip.value);
      case "availability":
        return bare(HEBREW_AVAILABILITY_DISPLAY);
      case "category":
        return bare(HEBREW_CATEGORY_DISPLAY[chip.value] ?? chip.value);
      case "occasion":
        return bare(HEBREW_OCCASION_DISPLAY[chip.value] ?? chip.value);
      default:
        return bare(chip.value);
    }
  }
  switch (chip.field) {
    case "priceMin":
      return bare(`Over ${chip.value}`);
    case "priceMax":
      return bare(`Under ${chip.value}`);
    case "colorsExclude":
    case "attributesExclude":
      return { negator: "Not", value: chip.value };
    case "availability":
      return bare("In stock");
    default:
      // category, colorsInclude, attributesInclude, occasion: the value
      // speaks for itself.
      return bare(chip.value);
  }
}

/** An inclusion: the whole label is the value, with nothing to strike. */
function bare(value: string): ChipLabelParts {
  return { negator: null, value };
}
