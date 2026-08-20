import { describe, expect, it } from "vitest";

import { chipLabel } from "../../widget/src/format";
import {
  EXAMPLES_FROM_CHROME_LOCALE,
  EXAMPLES_SHOWN,
  EXAMPLE_QUERIES,
  EXAMPLE_QUERY_KINDS,
  PLAYGROUND_LOCALES,
  exampleQueriesFor,
} from "./strings";

/**
 * Example queries and chip-label localization (YOY-93 AC-6, AC-1).
 *
 * The examples are the page's argument for itself (P-6), so what matters is
 * not that six strings exist but that they still cover the capabilities a
 * filter UI cannot express. Losing the negation example to an edit would
 * cost the page its point silently — hence the assertions on `kind`.
 */

describe("example queries", () => {
  it("offers at least six per language", () => {
    for (const locale of PLAYGROUND_LOCALES) {
      expect(EXAMPLE_QUERIES[locale].length).toBeGreaterThanOrEqual(6);
    }
  });

  it("covers every capability in both languages", () => {
    for (const locale of PLAYGROUND_LOCALES) {
      const kinds = EXAMPLE_QUERIES[locale].map((query) => query.kind);
      for (const kind of EXAMPLE_QUERY_KINDS) {
        expect(kinds, `${locale} is missing ${kind}`).toContain(kind);
      }
    }
  });

  it("has non-empty text everywhere, in the right script", () => {
    const hebrew = /[֐-׿]/;
    for (const locale of PLAYGROUND_LOCALES) {
      for (const query of EXAMPLE_QUERIES[locale]) {
        expect(query.text.trim()).not.toBe("");
        expect(hebrew.test(query.text), `${locale}: ${query.text}`).toBe(
          locale === "he",
        );
      }
    }
  });

  it("shows six: four in the chrome language and two in the other", () => {
    for (const locale of PLAYGROUND_LOCALES) {
      const shown = exampleQueriesFor(locale);
      expect(shown).toHaveLength(EXAMPLES_SHOWN);
      expect(shown.filter((entry) => entry.locale === locale)).toHaveLength(
        EXAMPLES_FROM_CHROME_LOCALE,
      );
      expect(shown.filter((entry) => entry.locale !== locale)).toHaveLength(
        EXAMPLES_SHOWN - EXAMPLES_FROM_CHROME_LOCALE,
      );
    }
  });

  it("never repeats a query in the shown set", () => {
    for (const locale of PLAYGROUND_LOCALES) {
      const texts = exampleQueriesFor(locale).map((entry) => entry.query.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });
});

describe("chip labels come from the widget's own display maps (AC-1)", () => {
  // The playground renders chips with `chipLabel` rather than a copy, so
  // these assert the localization the two surfaces now share: a divergence
  // would mean a shopper and a merchant reading different words for the
  // same constraint (P-5).
  const chips = [
    { field: "category", value: "dress" },
    { field: "priceMax", value: "400" },
    { field: "colorsExclude", value: "black" },
  ] as const;

  it("labels the applied constraints in English", () => {
    expect(chips.map((chip) => chipLabel(chip, { locale: "en" }))).toEqual([
      "dress",
      "Under 400",
      "Not black",
    ]);
  });

  it("labels them in Hebrew, with the currency the intent echoed", () => {
    expect(
      chips.map((chip) => chipLabel(chip, { locale: "he", currency: "ILS" })),
    ).toEqual(["שמלה", "עד 400 ILS", "לא שחור"]);
  });

  it("omits the currency when the response echoed none", () => {
    expect(chipLabel(chips[1], { locale: "he" })).toBe("עד 400");
  });
});
