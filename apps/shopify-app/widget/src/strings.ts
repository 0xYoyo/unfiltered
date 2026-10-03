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
  /** The one quiet line while the next page of results loads (YOY-146 AC-7). */
  loadingMore: string;
  noResults: string;
  /** The AI zero-hit message (YOY-49 AC-3). */
  zeroHit: string;
  closeMatchesHeading: string;
  /**
   * The close-matches heading when the server relaxed constraints to find
   * them (YOY-111 AC-4): {list} is the relaxed constraints, comma-joined,
   * each named by one of the `relaxed*` strings.
   */
  closeMatchesHeadingRelaxed: string;
  relaxedBudget: string;
  relaxedOccasion: string;
  relaxedAvailability: string;
  relaxedColors: string;
  relaxedCategory: string;
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
}

export const STRING_CATALOG: Record<WidgetLocale, WidgetStrings> = {
  en: {
    inputPlaceholder: "Search",
    loading: "Searching…",
    loadingMore: "Loading more…",
    noResults: "No results",
    zeroHit: "Nothing matches all of these",
    closeMatchesHeading: "Close matches",
    closeMatchesHeadingRelaxed: "Close matches — {list}",
    relaxedBudget: "over your budget",
    relaxedOccasion: "other occasions",
    relaxedAvailability: "including sold out",
    relaxedColors: "other colours",
    relaxedCategory: "other categories",
    newSearch: "New search",
    closeSearch: "Close search",
    searchResults: "Search results",
    appliedFilters: "Applied filters",
    removeFilter: "Remove filter: {label}",
    soldOut: "Sold out",
    colorNotConfirmed: "Color not confirmed",
    previewEmpty: "Keep typing…",
    chipPriceMax: "Under {money}",
    chipPriceMin: "Over {money}",
    chipSize: "Size {value}",
    chipInStock: "In stock",
    chipNegator: "Not",
  },
  he: {
    inputPlaceholder: "חיפוש",
    loading: "מחפש…",
    loadingMore: "טוען עוד…",
    noResults: "אין תוצאות",
    zeroHit: "שום פריט לא מתאים לכל הסינונים",
    closeMatchesHeading: "התאמות קרובות",
    closeMatchesHeadingRelaxed: "התאמות קרובות — {list}",
    relaxedBudget: "מעל התקציב",
    relaxedOccasion: "אירועים אחרים",
    relaxedAvailability: "כולל אזל מהמלאי",
    relaxedColors: "צבעים אחרים",
    relaxedCategory: "קטגוריות אחרות",
    newSearch: "חיפוש חדש",
    closeSearch: "סגירת החיפוש",
    searchResults: "תוצאות חיפוש",
    appliedFilters: "סינונים פעילים",
    removeFilter: "הסרת סינון: {label}",
    soldOut: "אזל מהמלאי",
    colorNotConfirmed: "צבע לא מאומת",
    previewEmpty: "המשיכו להקליד…",
    chipPriceMax: "עד {money}",
    chipPriceMin: "מעל {money}",
    chipSize: "מידה {value}",
    chipInStock: "במלאי",
    chipNegator: "לא",
  },
};

/** Hebrew locale codes ("he", "he-IL") get Hebrew chrome; all else English. */
/**
 * The close-matches heading for a response (YOY-111 AC-4): plain when the
 * server relaxed nothing, else "Close matches — <a>, <b>" naming each
 * relaxed constraint from the catalog. `priceMin` and `priceMax` are one
 * "budget" name, listed once; an unknown name (a newer server) is skipped
 * rather than rendered raw.
 */
export function closeMatchesHeadingText(
  strings: Pick<
    WidgetStrings,
    | "closeMatchesHeading"
    | "closeMatchesHeadingRelaxed"
    | "relaxedBudget"
    | "relaxedOccasion"
    | "relaxedAvailability"
    | "relaxedColors"
    | "relaxedCategory"
  >,
  relaxed: readonly string[] | undefined,
): string {
  const labels: string[] = [];
  for (const name of relaxed ?? []) {
    const label =
      name === "priceMax" || name === "priceMin"
        ? strings.relaxedBudget
        : name === "occasion"
          ? strings.relaxedOccasion
          : name === "availabilityRequired"
            ? strings.relaxedAvailability
            : name === "colorsInclude"
              ? strings.relaxedColors
              : name === "category"
                ? strings.relaxedCategory
                : null;
    if (label !== null && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels.length === 0
    ? strings.closeMatchesHeading
    : strings.closeMatchesHeadingRelaxed.replace(
        "{list}",
        labels.join(", "),
      );
}

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

/**
 * Hebrew display for the attribute words a negation chip carries (YOY-133):
 * the keys are the lexicon keys of `ATTRIBUTE_EVIDENCE_TERMS` in
 * packages/engine/src/taxonomy.ts (the engine owns the words and their
 * evidence, this map owns only their display). "Not wool" renders
 * "לא צמר"; an unlisted word renders as extracted, after "לא".
 */
export const HEBREW_ATTRIBUTE_DISPLAY: Record<string, string> = {
  wool: "צמר",
  cashmere: "קשמיר",
  leather: "עור",
  suede: "זמש",
  fur: "פרווה",
  cotton: "כותנה",
  linen: "פשתן",
  silk: "משי",
  satin: "סאטן",
  velvet: "קטיפה",
  lace: "תחרה",
  denim: "ג'ינס",
  polyester: "פוליאסטר",
  nylon: "ניילון",
  sleeves: "שרוולים",
  hood: "קפוצ'ון",
  pockets: "כיסים",
  zipper: "רוכסן",
  buttons: "כפתורים",
  collar: "צווארון",
  heels: "עקבים",
  print: "הדפס",
  stripes: "פסים",
  sequins: "פאייטים",
  logo: "לוגו",
  bridal: "כלה",
};
