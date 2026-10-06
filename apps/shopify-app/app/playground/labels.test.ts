import { describe, expect, it } from "vitest";

import {
  formatLabelMoney,
  LABEL_MAX_CHARS,
  LABEL_TEMPLATES,
  labelLocale,
  labelSegments,
  labelText,
} from "../../widget/src/labels";
import { STRING_CATALOG } from "../../widget/src/strings";
import { PLAYGROUND_STRING_CATALOG } from "./strings";

/**
 * The label line's templates and fill rule (YOY-151 AC-1, AC-2, AC-7), on
 * both string catalogs: the widget's (overlay and theme-native cards) and
 * the playground's. The UI lanes prove where the line renders; this proves
 * what it says.
 */

const TEMPLATES = {
  en: {
    labelPriceNear: "{price}, slightly over {cap}",
    labelPriceFar: "{price}, over your {cap}",
    labelSizeMissing: "no {size} — {sizes} in stock",
    labelFactDiffers: "in {have}, not {asked}",
    labelCloseMatch: "close match",
  },
  he: {
    labelPriceNear: "{price}, מעט מעל {cap}",
    labelPriceFar: "{price}, מעל ה-{cap} שביקשת",
    labelSizeMissing: "אין {size} — יש {sizes} במלאי",
    labelFactDiffers: "ב{have}, לא {asked}",
    labelCloseMatch: "התאמה קרובה",
  },
} as const;

const CATALOGS = [
  ["widget", STRING_CATALOG],
  ["playground", PLAYGROUND_STRING_CATALOG],
] as const;

describe("label templates (AC-1)", () => {
  for (const [surface, catalog] of CATALOGS) {
    for (const locale of ["en", "he"] as const) {
      it(`the ${surface} catalog holds the five ${locale} templates verbatim`, () => {
        for (const [key, template] of Object.entries(TEMPLATES[locale])) {
          expect(catalog[locale][key as keyof (typeof TEMPLATES)["en"]], `${surface}.${locale}.${key}`).toBe(template);
        }
      });
    }
  }

  it("fills every template in English", () => {
    const strings = STRING_CATALOG.en;
    expect(labelText(strings, { template: "price-near", values: ["420 ILS", "400 ILS"] })).toBe(
      "420 ILS, slightly over 400 ILS",
    );
    expect(labelText(strings, { template: "price-far", values: ["640 ILS", "400 ILS"] })).toBe(
      "640 ILS, over your 400 ILS",
    );
    expect(labelText(strings, { template: "size-missing", values: ["M", "S", "L"] })).toBe(
      "no M — S, L in stock",
    );
    expect(labelText(strings, { template: "fact-differs", values: ["linen", "silk"] })).toBe(
      "in linen, not silk",
    );
    expect(labelText(strings, { template: "close-match", values: [] })).toBe("close match");
  });

  it("fills every template in Hebrew", () => {
    const strings = PLAYGROUND_STRING_CATALOG.he;
    expect(labelText(strings, { template: "price-near", values: ["420 ILS", "400 ILS"] })).toBe(
      "420 ILS, מעט מעל 400 ILS",
    );
    expect(labelText(strings, { template: "price-far", values: ["640 ILS", "400 ILS"] })).toBe(
      "640 ILS, מעל ה-400 ILS שביקשת",
    );
    expect(labelText(strings, { template: "size-missing", values: ["M", "S"] })).toBe(
      "אין M — יש S במלאי",
    );
    expect(labelText(strings, { template: "fact-differs", values: ["פשתן", "משי"] })).toBe(
      "בפשתן, לא משי",
    );
    expect(labelText(strings, { template: "close-match", values: [] })).toBe("התאמה קרובה");
  });

  it("shows nothing for no label or a template it does not know", () => {
    expect(labelText(STRING_CATALOG.en, null)).toBeNull();
    expect(labelText(STRING_CATALOG.en, undefined)).toBeNull();
    expect(labelText(STRING_CATALOG.en, { template: "price-hidden", values: ["1"] })).toBeNull();
  });
});

describe("maximum filled length (AC-2)", () => {
  it("gives every template a maximum", () => {
    for (const template of LABEL_TEMPLATES) {
      expect(LABEL_MAX_CHARS[template]).toBeGreaterThan(0);
    }
  });

  it("shows a label at its maximum and drops one a character over it", () => {
    const max = LABEL_MAX_CHARS["fact-differs"];
    // "in " + have + ", not " + "x" is 10 characters around `have`.
    const fits = "a".repeat(max - 10);
    expect(labelText(STRING_CATALOG.en, { template: "fact-differs", values: [fits, "x"] })).toHaveLength(max);
    expect(
      labelText(STRING_CATALOG.en, { template: "fact-differs", values: [`${fits}a`, "x"] }),
    ).toBeNull();
  });

  it("drops the fixtures' over-length label on both surfaces", () => {
    const long = {
      template: "fact-differs",
      values: ["recycled organic linen blend", "pure mulberry silk"],
    };
    expect(labelText(STRING_CATALOG.en, long)).toBeNull();
    expect(labelText(PLAYGROUND_STRING_CATALOG.he, long)).toBeNull();
  });
});

describe("label language (AC-7)", () => {
  it("has templates for English and Hebrew storefronts only", () => {
    expect(labelLocale("en")).toBe("en");
    expect(labelLocale("en-GB")).toBe("en");
    expect(labelLocale("he")).toBe("he");
    expect(labelLocale("he-IL")).toBe("he");
    expect(labelLocale("fr")).toBeNull();
    expect(labelLocale("pt-BR")).toBeNull();
    expect(labelLocale("")).toBeNull();
  });
});

describe("price label amounts in the storefront's format (YOY-164 AC-2)", () => {
  // Intl's own output for the expected strings, so the test reads the
  // runtime's bidi marks the same way the label will.
  const intl = (locale: string, currency: string, amount: number, fraction: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fraction,
      maximumFractionDigits: 2,
    }).format(amount);

  it("formats a <number> <ISO code> value for the locale, whole amounts without decimals", () => {
    expect(formatLabelMoney("411.6 USD", "en")).toBe("$411.60");
    expect(formatLabelMoney("1188.6 USD", "en")).toBe("$1,188.60");
    expect(formatLabelMoney("450 ILS", "he")).toBe(intl("he", "ILS", 450, 0));
    expect(formatLabelMoney("450 ILS", "he")).toContain("450");
    expect(formatLabelMoney("450 ILS", "he")).toContain("₪");
    expect(formatLabelMoney("450 ILS", "he")).not.toContain(".");
  });

  it("leaves any other value as written", () => {
    expect(formatLabelMoney("M", "en")).toBe("M");
    expect(formatLabelMoney("linen", "he")).toBe("linen");
    expect(formatLabelMoney("120", "en")).toBe("120");
    expect(formatLabelMoney("12 XYZ1", "en")).toBe("12 XYZ1");
  });

  it("fills a price label with formatted amounts when a locale is given; other templates and no locale are unchanged", () => {
    const priceNear = { template: "price-near", values: ["411.6 USD", "400 USD"] };
    expect(labelText(STRING_CATALOG.en, priceNear)).toBe("411.6 USD, slightly over 400 USD");
    expect(
      labelSegments(STRING_CATALOG.en, priceNear, "en")!
        .map((segment) => segment.text)
        .join(""),
    ).toBe("$411.60, slightly over $400");
    const size = { template: "size-missing", values: ["M", "S", "L"] };
    expect(
      labelSegments(STRING_CATALOG.en, size, "en")!
        .map((segment) => segment.text)
        .join(""),
    ).toBe("no M — S, L in stock");
  });
});
