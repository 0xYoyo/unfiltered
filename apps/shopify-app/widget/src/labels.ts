/**
 * The label line (YOY-151): one honest line under a card's price saying how
 * a result misses a stated wish (DESIGN.md W-11). The server sends a
 * template name and its values (YOY-147 AC-9, YOY-149 AC-12); every surface
 * fills the template from its own string catalog, so the text is always in
 * the storefront's language and never composed on the server.
 *
 * Shared by the widget's two card paths and the playground card, so a label
 * can never read differently on the two surfaces (P-5).
 */

/** The five templates the server can name (YOY-151 AC-1). */
export const LABEL_TEMPLATES = [
  "price-near",
  "price-far",
  "size-missing",
  "fact-differs",
  "close-match",
] as const;
export type LabelTemplate = (typeof LABEL_TEMPLATES)[number];

/** A label as the wire carries it: a template name and its values in order. */
export interface LabelLike {
  template: string;
  values: readonly string[];
}

/** The catalog keys that hold the five templates, in either catalog. */
export interface LabelStrings {
  labelPriceNear: string;
  labelPriceFar: string;
  labelSizeMissing: string;
  labelFactDiffers: string;
  labelCloseMatch: string;
}

const TEMPLATE_KEYS: Record<LabelTemplate, keyof LabelStrings> = {
  "price-near": "labelPriceNear",
  "price-far": "labelPriceFar",
  "size-missing": "labelSizeMissing",
  "fact-differs": "labelFactDiffers",
  "close-match": "labelCloseMatch",
};

/**
 * The longest filled label each template may show, in characters (AC-2):
 * set so the longest allowed label fits a 180 px card at the playground's
 * caption size (12.5 px Assistant) in either language. Measured in the
 * playground's own type, realistic 34-character labels in EN and HE ran
 * 155–169 px ("999.90 ILS, מעל ה-500 ILS שביקשת" the widest); a filled
 * label over its maximum is not shown, and the width check (AC-6) catches
 * the rarer narrow-count, wide-glyph label the count lets through.
 */
export const LABEL_MAX_CHARS: Record<LabelTemplate, number> = {
  "price-near": 34,
  "price-far": 34,
  "size-missing": 34,
  "fact-differs": 34,
  "close-match": 16,
};

/**
 * The label language for a storefront locale (AC-7): English and Hebrew
 * have templates; any other locale — the widget's chrome falls back to
 * English there — shows no label at all, because an English sentence on a
 * French card would be a line the shopper cannot read.
 */
export function labelLocale(locale: string): "en" | "he" | null {
  const token = locale.toLowerCase();
  if (token === "he" || token.startsWith("he-")) {
    return "he";
  }
  if (token === "en" || token.startsWith("en-")) {
    return "en";
  }
  return null;
}

function isTemplate(name: string): name is LabelTemplate {
  return (LABEL_TEMPLATES as readonly string[]).includes(name);
}

/**
 * One run of a filled label: template text in the chrome's language, or a
 * filled value (an amount, a size, a product fact) that renders isolated —
 * a `<bdi>` — so a Latin "640 ILS" inside a Hebrew sentence keeps its own
 * direction and the sentence keeps the chrome's (X-7).
 */
export interface LabelSegment {
  text: string;
  value: boolean;
}

/** A wire money value: a number, a space, an ISO 4217 code (`411.6 USD`). */
const WIRE_MONEY = /^(\d+(?:\.\d+)?) ([A-Z]{3})$/;

/**
 * A price label's money value shown the storefront's way (YOY-164 AC-2):
 * `411.6 USD` on `en` reads `$411.60`, `450 ILS` on `he` reads `‏450 ₪` —
 * whole amounts without decimals, as the chip shows them. Any other value,
 * or a currency the runtime does not know, is left as written.
 */
export function formatLabelMoney(value: string, locale: string): string {
  const match = WIRE_MONEY.exec(value.trim());
  if (match === null) {
    return value;
  }
  const amount = Number(match[1]);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: match[2]!,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return value;
  }
}

/**
 * Fill a label's template (AC-1) into segments, or null when it must not be
 * shown: an unknown template (a newer server), or a filled text over the
 * template's maximum (AC-2). `size-missing` carries the asked size then
 * every in-stock size, which read as one comma-joined list. With a
 * `locale`, a price label's amounts are formatted for it (YOY-164 AC-2);
 * the widget's two card paths pass one, so both read the same.
 */
export function labelSegments(
  strings: LabelStrings,
  label: LabelLike | null | undefined,
  locale?: string,
): LabelSegment[] | null {
  if (label === null || label === undefined || !isTemplate(label.template)) {
    return null;
  }
  const money =
    locale !== undefined && (label.template === "price-near" || label.template === "price-far");
  const [first = "", second = "", ...rest] = money
    ? label.values.map((value) => formatLabelMoney(value, locale))
    : label.values;
  const values: Record<string, string> = {
    price: first,
    cap: second,
    size: first,
    sizes: [second, ...rest].filter((size) => size !== "").join(", "),
    have: first,
    asked: second,
  };
  const segments: LabelSegment[] = [];
  for (const [index, part] of strings[TEMPLATE_KEYS[label.template]]
    .split(/\{(\w+)\}/)
    .entries()) {
    // `split` with a capture group alternates text, placeholder, text…
    const segment =
      index % 2 === 0
        ? { text: part, value: false }
        : { text: values[part] ?? "", value: true };
    if (segment.text !== "") {
      segments.push(segment);
    }
  }
  const length = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  return length > LABEL_MAX_CHARS[label.template] ? null : segments;
}

/** The filled label as plain text, or null when it must not be shown. */
export function labelText(
  strings: LabelStrings,
  label: LabelLike | null | undefined,
): string | null {
  const segments = labelSegments(strings, label);
  return segments === null ? null : segments.map((segment) => segment.text).join("");
}

/**
 * Write a filled label into an element (the widget's two card paths):
 * template text as text nodes, each value in its own `<bdi>`.
 */
export function renderLabel(
  element: HTMLElement,
  segments: readonly LabelSegment[],
): void {
  element.replaceChildren(
    ...segments.map((segment) => {
      if (!segment.value) {
        return document.createTextNode(segment.text);
      }
      const isolated = document.createElement("bdi");
      isolated.textContent = segment.text;
      return isolated;
    }),
  );
}

/**
 * Whether a rendered label line is wider than its card (AC-6). A label is
 * never truncated or wrapped, so one that overflows is removed whole. The
 * line is `white-space: nowrap; overflow: hidden`, so its scroll width is
 * the text's own width and its client width the card's.
 */
export function labelOverflows(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 0.5;
}
