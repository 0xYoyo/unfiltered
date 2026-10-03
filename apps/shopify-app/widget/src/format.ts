import {
  HEBREW_ATTRIBUTE_DISPLAY,
  HEBREW_CATEGORY_DISPLAY,
  HEBREW_COLOR_DISPLAY,
  HEBREW_OCCASION_DISPLAY,
  STRING_CATALOG,
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

/**
 * The chip shape every surface labels: a field, its value, and — on an
 * engine v2 price chip (YOY-149) — the ISO currency of the shopper's own
 * number. Structural, so the widget's `ProxyChip` and the server's chip
 * type both satisfy it.
 */
export interface ChipLike {
  field: string;
  value: string;
  currency?: string;
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
 * word ("bridal" / "כלה"). Engine v2 chips (YOY-149) add `size`
 * ("Size M" / "מידה M"), `exclude` ("Not black" / "לא שחור", the term as
 * typed) and price chips carrying their own currency ("Under ₪400"). The
 * words come from the string catalog.
 *
 * The joined string; `chipLabelParts` is the same label with the negator
 * kept separate, for surfaces that mark an exclusion typographically.
 */
export function chipLabel(
  chip: ChipLike,
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
  // Engine v2 (YOY-149): one exclusion field for any excluded term.
  "exclude",
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
  chip: ChipLike,
  context: ChipDisplayContext = { locale: "en" },
): ChipLabelParts {
  const strings = STRING_CATALOG[context.locale];
  const hebrew = context.locale === "he";
  const money = chipMoney(chip, context);
  switch (chip.field) {
    case "priceMin":
      return bare(strings.chipPriceMin.replace("{money}", money));
    case "priceMax":
      return bare(strings.chipPriceMax.replace("{money}", money));
    case "size":
      // Engine v2 (YOY-149): the shopper's size, exactly as typed.
      return bare(strings.chipSize.replace("{value}", chip.value));
    case "availability":
      return bare(strings.chipInStock);
    case "exclude":
      // Engine v2 (YOY-149): the excluded term as the shopper typed it, in
      // whatever language they typed it — no display map, nothing to
      // translate.
      return { negator: strings.chipNegator, value: chip.value };
    case "colorsExclude":
      return {
        negator: strings.chipNegator,
        value: hebrew
          ? (HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value)
          : chip.value,
      };
    case "attributesExclude":
      return {
        negator: strings.chipNegator,
        value: hebrew
          ? (HEBREW_ATTRIBUTE_DISPLAY[chip.value] ?? chip.value)
          : chip.value,
      };
    case "colorsInclude":
      return bare(
        hebrew ? (HEBREW_COLOR_DISPLAY[chip.value] ?? chip.value) : chip.value,
      );
    case "attributesInclude":
      return bare(
        hebrew
          ? (HEBREW_ATTRIBUTE_DISPLAY[chip.value] ?? chip.value)
          : chip.value,
      );
    case "category":
      return bare(
        hebrew
          ? (HEBREW_CATEGORY_DISPLAY[chip.value] ?? chip.value)
          : chip.value,
      );
    case "occasion":
      return bare(
        hebrew
          ? (HEBREW_OCCASION_DISPLAY[chip.value] ?? chip.value)
          : chip.value,
      );
    default:
      // A field this client does not know (a newer server): the value
      // speaks for itself.
      return bare(chip.value);
  }
}

/**
 * The amount a price chip shows.
 *
 * An engine v2 chip (YOY-149) carries its own ISO `currency`: the shopper's
 * number is shown with that currency's symbol in the chrome language
 * ("₪400" / "‏400 ₪"), whole units only. Without one, the bare number.
 *
 * A v1 chip carries no currency of its own and keeps exactly the YOY-49 /
 * YOY-50 display: English shows the bare number, Hebrew appends the
 * intent's currency CODE ("400 ILS").
 */
function chipMoney(chip: ChipLike, context: ChipDisplayContext): string {
  if (chip.currency !== undefined && chip.currency !== "") {
    const amount = Number(chip.value);
    if (chip.value.trim() !== "" && Number.isFinite(amount)) {
      try {
        return new Intl.NumberFormat(context.locale, {
          style: "currency",
          currency: chip.currency,
          maximumFractionDigits: 0,
        }).format(amount);
      } catch {
        // An ISO code this runtime does not know: number and code.
      }
    }
    return `${chip.value} ${chip.currency}`;
  }
  if (context.locale === "he" && context.currency !== undefined) {
    return `${chip.value} ${context.currency}`;
  }
  return chip.value;
}

/** An inclusion: the whole label is the value, with nothing to strike. */
function bare(value: string): ChipLabelParts {
  return { negator: null, value };
}
