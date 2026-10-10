/**
 * Shopper-visible chrome strings (YOY-50).
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
  /** The one quiet line while the next page of results loads (YOY-146 AC-7). */
  loadingMore: string;
  noResults: string;
  /** The AI zero-hit message (YOY-49 AC-3). */
  zeroHit: string;
  /** The "Close matches" divider on a judged page (YOY-166). */
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
  /**
   * The second-reading chip (YOY-150 AC-8), first in the chip row; tapping
   * it searches {reading} afresh. {reading} is the judge's phrase.
   */
  otherReading: string;
  soldOut: string;
  /** Quiet empty state while a keystroke preview has no matches (YOY-68
   * AC-4) — deliberately softer than the submitted `noResults` panel. */
  previewEmpty: string;
  /**
   * Chip labels (YOY-149 AC-16; the v1 wording moved here unchanged).
   * {money} is the shopper's number, with its currency when the chip
   * carries one; {value} is the chip's value as typed.
   */
  chipPriceMax: string;
  chipPriceMin: string;
  chipSize: string;
  chipInStock: string;
  /** The word an exclusion chip leads with; the value after it is struck. */
  chipNegator: string;
  /**
   * The label line's five templates (YOY-151 AC-1), filled by `labelText`
   * in labels.ts: {size} the size asked for, {have} the product's value
   * and {asked} the shopper's. The price labels carry no numbers (YOY-168
   * AC-1): the cap is on the chip and the price is on the card.
   */
  labelPriceNear: string;
  labelPriceFar: string;
  labelSizeMissing: string;
  labelFactDiffers: string;
  labelCloseMatch: string;
  /** A product the judge never answered for (YOY-171 AC-2). */
  labelUnchecked: string;
}

export const STRING_CATALOG: Record<WidgetLocale, WidgetStrings> = {
  en: {
    inputPlaceholder: "Search",
    loading: "Searching…",
    loadingMore: "Loading more…",
    noResults: "No results",
    zeroHit: "Nothing matches all of these",
    closeMatchesHeading: "Close matches",
    newSearch: "New search",
    closeSearch: "Close search",
    searchResults: "Search results",
    appliedFilters: "Applied filters",
    removeFilter: "Remove filter: {label}",
    otherReading: "{reading} instead?",
    soldOut: "Sold out",
    previewEmpty: "Keep typing…",
    chipPriceMax: "Under {money}",
    chipPriceMin: "Over {money}",
    chipSize: "Size {value}",
    chipInStock: "In stock",
    chipNegator: "Not",
    labelPriceNear: "slightly over budget",
    labelPriceFar: "over budget",
    labelSizeMissing: "size {size} not in stock",
    labelFactDiffers: "in {have}, not {asked}",
    labelCloseMatch: "close match",
    labelUnchecked: "not checked yet",
  },
  he: {
    inputPlaceholder: "חיפוש",
    loading: "מחפש…",
    loadingMore: "טוען עוד…",
    noResults: "אין תוצאות",
    zeroHit: "שום פריט לא מתאים לכל הסינונים",
    closeMatchesHeading: "התאמות קרובות",
    newSearch: "חיפוש חדש",
    closeSearch: "סגירת החיפוש",
    searchResults: "תוצאות חיפוש",
    appliedFilters: "סינונים פעילים",
    removeFilter: "הסרת סינון: {label}",
    otherReading: "{reading} במקום?",
    soldOut: "אזל מהמלאי",
    previewEmpty: "המשיכו להקליד…",
    chipPriceMax: "עד {money}",
    chipPriceMin: "מעל {money}",
    chipSize: "מידה {value}",
    chipInStock: "במלאי",
    chipNegator: "לא",
    labelPriceNear: "מעט מעל התקציב",
    labelPriceFar: "מעל התקציב",
    labelSizeMissing: "מידה {size} לא במלאי",
    labelFactDiffers: "ב{have}, לא {asked}",
    labelCloseMatch: "התאמה קרובה",
    labelUnchecked: "עוד לא נבדק",
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
