/**
 * Shopper-visible chrome strings and Hebrew display maps (YOY-50).
 *
 * Every string the widget renders comes from this catalog, with complete EN
 * and HE sets — the WidgetStrings interface makes a missing key a compile
 * error and the localization suite asserts parity at runtime (AC-1). Chrome
 * language follows the storefront locale the embed block passes: Hebrew →
 * Hebrew, anything else → English (AC-2, NG-2). Query language stays
 * independent of chrome language — nothing here touches query text, and
 * canonical values in requests remain lowercase English (NG-3).
 */

export const WIDGET_LOCALES = ["en", "he"] as const;
export type WidgetLocale = (typeof WIDGET_LOCALES)[number];

export interface WidgetStrings {
  /** The theme search input's placeholder while the widget owns it. */
  inputPlaceholder: string;
  loading: string;
  noResults: string;
  /** The AI zero-hit message (YOY-49 AC-3). */
  zeroHit: string;
  closeMatchesHeading: string;
  newSearch: string;
  /** aria-label of the close control. */
  closeSearch: string;
  /** aria-label of the overlay dialog. */
  searchResults: string;
  /** aria-label of the chip row. */
  appliedFilters: string;
  /** aria template for chip remove buttons; {label} is the chip's text. */
  removeFilter: string;
  soldOut: string;
  /** Label on results that passed a color filter without color evidence
   * (YOY-67 AC-5). */
  colorNotConfirmed: string;
}

export const STRING_CATALOG: Record<WidgetLocale, WidgetStrings> = {
  en: {
    inputPlaceholder: "Search",
    loading: "Searching…",
    noResults: "No results",
    zeroHit: "Nothing matches all of these",
    closeMatchesHeading: "Close matches",
    newSearch: "New search",
    closeSearch: "Close search",
    searchResults: "Search results",
    appliedFilters: "Applied filters",
    removeFilter: "Remove filter: {label}",
    soldOut: "Sold out",
    colorNotConfirmed: "Color not confirmed",
  },
  he: {
    inputPlaceholder: "חיפוש",
    loading: "מחפש…",
    noResults: "אין תוצאות",
    zeroHit: "שום פריט לא מתאים לכל הסינונים",
    closeMatchesHeading: "התאמות קרובות",
    newSearch: "חיפוש חדש",
    closeSearch: "סגירת החיפוש",
    searchResults: "תוצאות חיפוש",
    appliedFilters: "סינונים פעילים",
    removeFilter: "הסרת סינון: {label}",
    soldOut: "אזל מהמלאי",
    colorNotConfirmed: "צבע לא מאומת",
  },
};

/** Hebrew locale codes ("he", "he-IL") get Hebrew chrome; all else English. */
export function resolveLocale(locale: string): WidgetLocale {
  const token = locale.toLowerCase();
  return token === "he" || token.startsWith("he-") ? "he" : "en";
}

export function getStrings(locale: string): WidgetStrings {
  return STRING_CATALOG[resolveLocale(locale)];
}

/**
 * Hebrew display strings for canonical taxonomy values (AC-4). The category
 * and occasion keys mirror packages/engine/src/taxonomy.ts — the engine owns
 * the canonical sets, this map owns only their Hebrew display (the engine
 * stays display-free, NG-3) — plus a fixed list of common canonical colors.
 * Values outside these maps render exactly as extracted.
 */
export const HEBREW_CATEGORY_DISPLAY: Record<string, string> = {
  dress: "שמלה",
  top: "חולצה",
  skirt: "חצאית",
  pants: "מכנסיים",
  coat: "מעיל",
  jacket: "ז'קט",
  shoes: "נעליים",
  boots: "מגפיים",
  sneakers: "סניקרס",
  bag: "תיק",
  jewelry: "תכשיטים",
  accessories: "אקססוריז",
  swimwear: "בגדי ים",
  other: "אחר",
};

export const HEBREW_OCCASION_DISPLAY: Record<string, string> = {
  casual: "יומיומי",
  work: "עבודה",
  evening: "ערב",
  wedding: "חתונה",
  beach: "חוף",
  sport: "ספורט",
  other: "אחר",
};

export const HEBREW_COLOR_DISPLAY: Record<string, string> = {
  black: "שחור",
  white: "לבן",
  red: "אדום",
  blue: "כחול",
  green: "ירוק",
  yellow: "צהוב",
  pink: "ורוד",
  purple: "סגול",
  orange: "כתום",
  brown: "חום",
  grey: "אפור",
  gray: "אפור",
  beige: "בז'",
  gold: "זהב",
  silver: "כסף",
  navy: "כחול כהה",
};

export const HEBREW_AVAILABILITY_DISPLAY = "במלאי";
