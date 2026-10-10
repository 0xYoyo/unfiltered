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
  /** The wordmark in the top bar — the display face, no logo or mark. */
  productName: string;
  /**
   * The hero's eyebrow line (YOY-123): the kit's tagline direction, set in
   * the one uppercase style on the page.
   */
  heroEyebrow: string;
  /** The hero heading — the page's one display-size line of text. */
  heroHeading: string;
  /** One paragraph under the heading saying what this page is. */
  heroSubcopy: string;
  searchPlaceholder: string;
  /** aria-label of the magnifier submit button. */
  searchSubmit: string;
  /** aria-label of the search landmark. */
  searchLabel: string;
  /** Quiet hint under the bar before anything has been searched (AC-7). */
  initialHint: string;
  /** The single quiet status line while a search is in flight (AC-7). */
  loading: string;
  /** The one quiet line below the grid while the next page loads (YOY-146 AC-7). */
  loadingMore: string;
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
  /** The eyebrow that names what the chips are (YOY-123). */
  chipsLead: string;
  /** aria template for a chip's remove control; {label} is the chip's text. */
  removeFilter: string;
  /**
   * The second-reading chip (YOY-150 AC-8), first in the chip row; tapping
   * it searches {reading} afresh. {reading} is the judge's phrase.
   */
  otherReading: string;
  /** AI zero-hit: nothing satisfied every applied constraint. */
  zeroHit: string;
  /** The heading of a judged page's close products (YOY-166). */
  closeMatchesHeading: string;
  /** The one secondary button, shown once a refinement chain is held. */
  newSearch: string;
  /**
   * The card's label line (YOY-151 AC-1), the widget's five templates
   * verbatim, filled by `labelText` in widget/src/labels.ts: {size} the
   * size asked for, {have} the product's value and {asked} the visitor's.
   * The price labels carry no numbers (YOY-168 AC-1): the cap is on the
   * chip and the price is on the card.
   */
  labelPriceNear: string;
  labelPriceFar: string;
  labelSizeMissing: string;
  labelFactDiffers: string;
  labelCloseMatch: string;
  /** A product the judge never answered for (YOY-171 AC-2). */
  labelUnchecked: string;
  /** The engine-details toggle (P-4), off by default. */
  engineDetailsToggle: string;
  /** Field labels inside the engine-details panel. */
  detailsRoute: string;
  detailsRouteReason: string;
  detailsLatency: string;
  detailsDegraded: string;
  detailsLimited: string;
  /** Heading of the per-stage timing rows (YOY-114). */
  detailsStages: string;
  /** Value shown for a detail the response left null. */
  detailsNone: string;
  detailsYes: string;
  detailsNo: string;
  /** Lead-in on the collapsed example row after a search. */
  examplesLead: string;
  /** aria-label of the example-query list. */
  examplesLabel: string;

  // --- Store-preload page (YOY-94) ---

  /** Document title on `/s/<slug>`; {name} is the store's name. */
  storeTitle: string;
  /** Muted count beside the store's name; {count} is the product count. */
  storeProducts: string;
  /** The unknown-slug page: one sentence, no error language (F-6). */
  catalogNotFound: string;
  /** Label on the link back to the seed playground. */
  backToPlayground: string;
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
    heroEyebrow: "Your shoppers don't think in filters",
    heroHeading: "Type like a person. See what happens.",
    heroSubcopy:
      "A demo store with a real fashion catalogue, open to anyone. Ask it for something the way you'd ask a person in the shop, and watch it take the sentence apart.",
    searchPlaceholder: "elegant summer wedding dress, not black",
    searchSubmit: "Search",
    searchLabel: "Search the catalog",
    initialHint: "Type the way you would say it out loud.",
    loading: "Searching…",
    loadingMore: "Loading more…",
    emptyResults: "Nothing matched that.",
    requestFailed: "That search did not come back. Try again.",
    resultsLabel: "Results",
    soldOut: "Sold out",
    footerNote: "A demo catalog. Prices and stock are not real.",
    languageToggle: "Change language",
    languageToggleTarget: "עברית",

    appliedFilters: "Applied filters",
    chipsLead: "Understood as",
    removeFilter: "Remove filter: {label}",
    otherReading: "{reading} instead?",
    zeroHit: "Nothing matches all of these",
    closeMatchesHeading: "Close matches",
    newSearch: "New search",
    labelPriceNear: "slightly over budget",
    labelPriceFar: "over budget",
    labelSizeMissing: "size {size} not in stock",
    labelFactDiffers: "in {have}, not {asked}",
    labelCloseMatch: "close match",
    labelUnchecked: "not checked yet",
    engineDetailsToggle: "How it understood you",
    detailsRoute: "Route",
    detailsRouteReason: "Reason",
    detailsLatency: "Latency",
    detailsDegraded: "Degraded",
    detailsLimited: "Limited",
    detailsStages: "Stages",
    detailsNone: "none",
    detailsYes: "yes",
    detailsNo: "no",
    examplesLead: "Try:",
    examplesLabel: "Example searches",

    storeTitle: "{name} — Unfiltered",
    storeProducts: "{count} products",
    catalogNotFound: "There is no catalog at this link.",
    backToPlayground: "Search the demo catalog",
  },
  he: {
    pageTitle: "Unfiltered — חיפוש בקטלוג אופנה במילים שלך",
    metaDescription:
      "תארו מה אתם מחפשים בדיוק כמו שהייתם אומרים בקול, וראו קטלוג אופנה עונה.",
    productName: "Unfiltered",
    heroEyebrow: "הקונים שלכם לא חושבים במסננים",
    heroHeading: "כתבו כמו בני אדם. תראו מה קורה.",
    heroSubcopy:
      "חנות הדגמה עם קטלוג אופנה אמיתי, פתוחה לכולם. בקשו משהו בדיוק כמו שהייתם מבקשים ממוכרת בחנות, ותראו איך המשפט מתפרק.",
    searchPlaceholder: "שמלה אלגנטית לחתונה בקיץ, לא שחורה",
    searchSubmit: "חיפוש",
    searchLabel: "חיפוש בקטלוג",
    initialHint: "כתבו בדיוק כמו שהייתם אומרים בקול.",
    loading: "מחפש…",
    loadingMore: "טוען עוד…",
    emptyResults: "לא נמצאה התאמה.",
    requestFailed: "החיפוש לא חזר. נסו שוב.",
    resultsLabel: "תוצאות",
    soldOut: "אזל מהמלאי",
    footerNote: "קטלוג הדגמה. המחירים והמלאי אינם אמיתיים.",
    languageToggle: "שינוי שפה",
    languageToggleTarget: "English",

    appliedFilters: "מסננים פעילים",
    chipsLead: "הבנו אותך כך",
    removeFilter: "הסרת מסנן: {label}",
    otherReading: "{reading} במקום?",
    zeroHit: "אין פריט שעונה על כל אלה",
    closeMatchesHeading: "התאמות קרובות",
    newSearch: "חיפוש חדש",
    labelPriceNear: "מעט מעל התקציב",
    labelPriceFar: "מעל התקציב",
    labelSizeMissing: "מידה {size} לא במלאי",
    labelFactDiffers: "ב{have}, לא {asked}",
    labelCloseMatch: "התאמה קרובה",
    labelUnchecked: "עוד לא נבדק",
    engineDetailsToggle: "איך זה הבין אתכם",
    detailsRoute: "מסלול",
    detailsRouteReason: "סיבה",
    detailsLatency: "זמן תגובה",
    detailsDegraded: "מצומצם",
    detailsLimited: "הוגבל",
    detailsStages: "שלבים",
    detailsNone: "אין",
    detailsYes: "כן",
    detailsNo: "לא",
    examplesLead: "נסו:",
    examplesLabel: "חיפושים לדוגמה",

    storeTitle: "{name} — Unfiltered",
    storeProducts: "{count} מוצרים",
    catalogNotFound: "אין קטלוג בקישור הזה.",
    backToPlayground: "חיפוש בקטלוג ההדגמה",
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

/** The marketing site's pages (app/site/). English-only, LTR. */
const SITE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/how-it-works",
  "/pricing",
  "/faq",
  "/privacy",
  "/terms",
]);

/**
 * Which owned page a path renders, if any. Owned pages self-host their
 * fonts and never load the admin's Shopify-CDN stylesheet; of them, only
 * the playground (`/try` and the store-preload pages at `/s/<slug>`)
 * resolves a chrome language — the marketing site is English and LTR.
 * Everything else is `null`: A-4 fixes the merchant admin (and its Polaris
 * login page) at English and LTR, and a JSON response has no direction.
 *
 * A trailing slash does not change the page — the router serves `/pricing/`
 * as `/pricing` — so it does not change the answer either.
 */
export function ownedPageKind(pathname: string): "playground" | "site" | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/try" || path === "/s" || path.startsWith("/s/")) {
    return "playground";
  }
  return SITE_PATHS.has(path) ? "site" : null;
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
    { kind: "colorAvailability", text: "brown boots in stock" },
    { kind: "refinement", text: "same but under 400" },
  ],
  he: [
    { kind: "negation", text: "שמלת קיץ, לא שחורה" },
    { kind: "priceCap", text: "חולצת פשתן עד 300" },
    { kind: "occasion", text: "משהו ללבוש לחתונה" },
    { kind: "softAttribute", text: "מעיל אוברסייז שנופל יפה" },
    { kind: "colorAvailability", text: "מגפיים חומים במלאי" },
    { kind: "refinement", text: "אותו דבר אבל עד 400" },
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
