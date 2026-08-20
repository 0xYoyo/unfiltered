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
