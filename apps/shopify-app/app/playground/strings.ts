/**
 * Playground chrome strings (YOY-92 AC-3), EN and HE.
 *
 * Same pattern as the widget's catalog (`widget/src/strings.ts`): the
 * `PlaygroundStrings` interface makes a missing key a compile error and
 * `playground-strings.test.ts` asserts parity at runtime. No visible text is
 * written into playground markup (F-7).
 *
 * Chrome language is resolved server-side so `<html lang dir>` is correct in
 * the first byte: `?lang=he|en` wins, then `Accept-Language`, then English.
 * Query language stays independent — nothing here touches query text.
 */

export const PLAYGROUND_LOCALES = ["en", "he"] as const;
export type PlaygroundLocale = (typeof PLAYGROUND_LOCALES)[number];

export interface PlaygroundStrings {
  /** Document title (AC-1). */
  pageTitle: string;
  /** Document meta description (AC-1). */
  metaDescription: string;
  /** The product name in the header — body type, no logo or mark (AC-4). */
  productName: string;
  searchPlaceholder: string;
  /** aria-label of the magnifier submit button. */
  searchSubmit: string;
  /** aria-label of the search landmark. */
  searchLabel: string;
  /** Quiet hint under the bar before anything has been searched (AC-7). */
  initialHint: string;
  /** The single quiet status line while a search is in flight (AC-7). */
  loading: string;
  /** Classic search that matched nothing (AC-7). */
  emptyResults: string;
  /**
   * A request that failed or timed out. Deliberately not error language and
   * never in an error colour: the previous results stay on screen and this
   * line invites a retry (F-6, W-8, X-4).
   */
  requestFailed: string;
  /** aria-label of the results grid. */
  resultsLabel: string;
  soldOut: string;
  /** The one muted footer line. */
  footerNote: string;
  /** aria-label of the language toggle. */
  languageToggle: string;
  /** Visible label of the language toggle: the language it switches TO. */
  languageToggleTarget: string;

  // --- AI states (YOY-93) ---

  /** aria-label of the chip row. */
  appliedFilters: string;
  /** aria template for a chip's remove control; {label} is the chip's text. */
  removeFilter: string;
  /** AI zero-hit: nothing satisfied every applied constraint. */
  zeroHit: string;
  closeMatchesHeading: string;
  /** The one secondary button, shown once an AI response is held. */
  newSearch: string;
  /** Label on a card that passed a colour filter without colour evidence. */
  colorNotConfirmed: string;
  /** The engine-details toggle (P-4), off by default. */
  engineDetailsToggle: string;
  /** Field labels inside the engine-details panel. */
  detailsRoute: string;
  detailsRouteReason: string;
  detailsLatency: string;
  detailsDegraded: string;
  detailsLimited: string;
  detailsIntent: string;
  /** Value shown for a detail the response left null. */
  detailsNone: string;
  detailsYes: string;
  detailsNo: string;
  /** Lead-in on the collapsed example row after a search. */
  examplesLead: string;
  /** aria-label of the example-query list. */
  examplesLabel: string;
}

export const PLAYGROUND_STRING_CATALOG: Record<
  PlaygroundLocale,
  PlaygroundStrings
> = {
  en: {
    pageTitle: "Unfiltered — search a fashion catalog in your own words",
    metaDescription:
      "Describe what you are looking for the way you would say it out loud, and see a fashion catalog answer.",
    productName: "Unfiltered",
    searchPlaceholder: "elegant summer wedding dress, not black",
    searchSubmit: "Search",
    searchLabel: "Search the catalog",
    initialHint: "Type the way you would say it out loud.",
    loading: "Searching…",
    emptyResults: "Nothing matched that.",
    requestFailed: "That search did not come back. Try again.",
    resultsLabel: "Results",
    soldOut: "Sold out",
    footerNote: "A demo catalog. Prices and stock are not real.",
    languageToggle: "Change language",
    languageToggleTarget: "עברית",

    appliedFilters: "Applied filters",
    removeFilter: "Remove filter: {label}",
    zeroHit: "Nothing matches all of these",
    closeMatchesHeading: "Close matches",
    newSearch: "New search",
    colorNotConfirmed: "Color not confirmed",
    engineDetailsToggle: "How it understood you",
    detailsRoute: "Route",
    detailsRouteReason: "Reason",
    detailsLatency: "Latency",
    detailsDegraded: "Degraded",
    detailsLimited: "Limited",
    detailsIntent: "Extracted intent",
    detailsNone: "none",
    detailsYes: "yes",
    detailsNo: "no",
    examplesLead: "Try:",
    examplesLabel: "Example searches",
  },
  he: {
    pageTitle: "Unfiltered — חיפוש בקטלוג אופנה במילים שלך",
    metaDescription:
      "תארו מה אתם מחפשים בדיוק כמו שהייתם אומרים בקול, וראו קטלוג אופנה עונה.",
    productName: "Unfiltered",
    searchPlaceholder: "שמלה אלגנטית לחתונה בקיץ, לא שחורה",
    searchSubmit: "חיפוש",
    searchLabel: "חיפוש בקטלוג",
    initialHint: "כתבו בדיוק כמו שהייתם אומרים בקול.",
    loading: "מחפש…",
    emptyResults: "לא נמצאה התאמה.",
    requestFailed: "החיפוש לא חזר. נסו שוב.",
    resultsLabel: "תוצאות",
    soldOut: "אזל מהמלאי",
    footerNote: "קטלוג הדגמה. המחירים והמלאי אינם אמיתיים.",
    languageToggle: "שינוי שפה",
    languageToggleTarget: "English",

    appliedFilters: "מסננים פעילים",
    removeFilter: "הסרת מסנן: {label}",
    zeroHit: "אין פריט שעונה על כל אלה",
    closeMatchesHeading: "התאמות קרובות",
    newSearch: "חיפוש חדש",
    colorNotConfirmed: "הצבע לא אומת",
    engineDetailsToggle: "איך זה הבין אתכם",
    detailsRoute: "מסלול",
    detailsRouteReason: "סיבה",
    detailsLatency: "זמן תגובה",
    detailsDegraded: "מצומצם",
    detailsLimited: "הוגבל",
    detailsIntent: "כוונה שחולצה",
    detailsNone: "אין",
    detailsYes: "כן",
    detailsNo: "לא",
    examplesLead: "נסו:",
    examplesLabel: "חיפושים לדוגמה",
  },
};

/** Text direction of a chrome language (AC-3). */
export function localeDirection(locale: PlaygroundLocale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr";
}

/** Narrow any locale token onto a supported chrome language. */
export function resolvePlaygroundLocale(
  locale: string | null | undefined,
): PlaygroundLocale {
  const token = (locale ?? "").toLowerCase();
  return token === "he" || token.startsWith("he-") ? "he" : "en";
}

export function getPlaygroundStrings(
  locale: PlaygroundLocale,
): PlaygroundStrings {
  return PLAYGROUND_STRING_CATALOG[locale];
}

/**
 * `?lang=` when it names a supported language, else the best
 * `Accept-Language` match, else English (AC-3). An unsupported `?lang=`
 * value falls through to the header rather than forcing English: the
 * parameter is a visitor's request, not an assertion about the browser.
 */
export function resolveChromeLocale(
  searchParams: URLSearchParams,
  acceptLanguage: string | null,
): PlaygroundLocale {
  const requested = searchParams.get("lang");
  if (requested !== null) {
    const token = requested.toLowerCase();
    if (token === "he" || token.startsWith("he-")) {
      return "he";
    }
    if (token === "en" || token.startsWith("en-")) {
      return "en";
    }
  }
  return localeFromAcceptLanguage(acceptLanguage);
}

/**
 * First acceptable language wins, by q-value then by order — the browser
 * already sorted its preferences and a `he` anywhere ahead of `en` means a
 * Hebrew reader.
 */
export function localeFromAcceptLanguage(
  header: string | null,
): PlaygroundLocale {
  if (header === null || header.trim() === "") {
    return "en";
  }
  const entries = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const q = quality === undefined ? 1 : Number(quality.slice(2));
      return {
        tag: tag.trim().toLowerCase(),
        q: Number.isFinite(q) ? q : 0,
        index,
      };
    })
    .filter((entry) => entry.q > 0 && entry.tag !== "")
    .sort((a, b) => (b.q === a.q ? a.index - b.index : b.q - a.q));

  for (const entry of entries) {
    if (entry.tag === "he" || entry.tag.startsWith("he-")) {
      return "he";
    }
    if (entry.tag === "en" || entry.tag.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

/**
 * Which paths render the playground and therefore resolve a chrome
 * language. The merchant admin and the API routes are excluded: A-4 fixes
 * the admin at English and LTR, and a JSON response has no direction.
 */
export function isPlaygroundPath(pathname: string): boolean {
  return pathname === "/";
}

/**
 * Curated example queries (YOY-93 AC-6, P-6). Fashion only, and each one
 * exists to show a different thing the engine does that a filter UI cannot:
 * negation, a price ceiling, an occasion that is not a category, a soft
 * attribute, colour plus availability, and a refinement pair.
 *
 * `kind` is not rendered — it is what `playground-examples.test.ts` asserts
 * against, so a later edit cannot quietly drop a capability from the set.
 */
export const EXAMPLE_QUERY_KINDS = [
  "negation",
  "priceCap",
  "occasion",
  "softAttribute",
  "colorAvailability",
  "refinement",
] as const;

export type ExampleQueryKind = (typeof EXAMPLE_QUERY_KINDS)[number];

export interface ExampleQuery {
  kind: ExampleQueryKind;
  text: string;
}

export const EXAMPLE_QUERIES: Record<PlaygroundLocale, ExampleQuery[]> = {
  en: [
    { kind: "negation", text: "summer dress, not black" },
    { kind: "priceCap", text: "linen shirt under 300" },
    { kind: "occasion", text: "something to wear to a wedding" },
    { kind: "softAttribute", text: "an oversized coat that drapes well" },
    { kind: "colorAvailability", text: "beige boots in stock" },
    { kind: "refinement", text: "same but cheaper" },
  ],
  he: [
    { kind: "negation", text: "שמלת קיץ, לא שחורה" },
    { kind: "priceCap", text: "חולצת פשתן עד 300" },
    { kind: "occasion", text: "משהו ללבוש לחתונה" },
    { kind: "softAttribute", text: "מעיל אוברסייז שנופל יפה" },
    { kind: "colorAvailability", text: "מגפיים בז' במלאי" },
    { kind: "refinement", text: "אותו דבר אבל זול יותר" },
  ],
};

/** How many examples the page shows, and how many come from each language. */
export const EXAMPLES_SHOWN = 6;
export const EXAMPLES_FROM_CHROME_LOCALE = 4;

/**
 * The six the page shows: four in the chrome language, two in the other
 * (AC-6). Both languages appear because the playground's whole claim is that
 * it understands either one — showing only the reader's own would prove half
 * of it. Each carries the locale it belongs to so the markup can set `dir`
 * per link (X-7).
 */
export function exampleQueriesFor(
  locale: PlaygroundLocale,
): { locale: PlaygroundLocale; query: ExampleQuery }[] {
  const other: PlaygroundLocale = locale === "he" ? "en" : "he";
  return [
    ...EXAMPLE_QUERIES[locale]
      .slice(0, EXAMPLES_FROM_CHROME_LOCALE)
      .map((query) => ({ locale, query })),
    ...EXAMPLE_QUERIES[other]
      .slice(0, EXAMPLES_SHOWN - EXAMPLES_FROM_CHROME_LOCALE)
      .map((query) => ({ locale: other, query })),
  ];
}
