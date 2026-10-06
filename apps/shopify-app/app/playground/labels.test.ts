import { describe, expect, it } from "vitest";

import {
  formatLabelMoney,
  LABEL_MAX_CHARS,
  LABEL_TEMPLATES,
  labelLocale,
  labelSegments,
  labelText,
  underCloseHeading,
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
    labelPriceNear: "slightly over budget",
    labelPriceFar: "over budget",
    labelSizeMissing: "size {size} not in stock",
    labelFactDiffers: "in {have}, not {asked}",
    labelCloseMatch: "close match",
  },
  he: {
    labelPriceNear: "מעט מעל התקציב",
    labelPriceFar: "מעל התקציב",
    labelSizeMissing: "מידה {size} לא במלאי",
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
    // The price labels carry no numbers (YOY-168 AC-1); the wire's values stay.
    expect(labelText(strings, { template: "price-near", values: ["420 ILS", "400 ILS"] })).toBe(
      "slightly over budget",
    );
    expect(labelText(strings, { template: "price-far", values: ["640 ILS", "400 ILS"] })).toBe(
      "over budget",
    );
    // The size label keeps its one value, the size asked for (YOY-168 AC-2).
    expect(labelText(strings, { template: "size-missing", values: ["M", "S", "L"] })).toBe(
      "size M not in stock",
    );
    expect(labelText(strings, { template: "fact-differs", values: ["linen", "silk"] })).toBe(
      "in linen, not silk",
    );
    expect(labelText(strings, { template: "close-match", values: [] })).toBe("close match");
  });

  it("fills every template in Hebrew", () => {
    const strings = PLAYGROUND_STRING_CATALOG.he;
    expect(labelText(strings, { template: "price-near", values: ["420 ILS", "400 ILS"] })).toBe(
      "מעט מעל התקציב",
    );
    expect(labelText(strings, { template: "price-far", values: ["640 ILS", "400 ILS"] })).toBe(
      "מעל התקציב",
    );
    expect(labelText(strings, { template: "size-missing", values: ["M", "S"] })).toBe(
      "מידה M לא במלאי",
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

  it("a price label shows no amount with or without a locale (YOY-168 AC-1); the size label is unchanged by one", () => {
    const priceNear = { template: "price-near", values: ["411.6 USD", "400 USD"] };
    for (const locale of [undefined, "en"]) {
      const text = labelSegments(STRING_CATALOG.en, priceNear, locale)!
        .map((segment) => segment.text)
        .join("");
      expect(text).toBe("slightly over budget");
      expect(text).not.toMatch(/\d/);
    }
    const size = { template: "size-missing", values: ["M", "S", "L"] };
    expect(
      labelSegments(STRING_CATALOG.en, size, "en")!
        .map((segment) => segment.text)
        .join(""),
    ).toBe("size M not in stock");
  });
});

describe("no close-match label under the heading (YOY-168 AC-3)", () => {
  const card = (template: string | null) => ({
    productId: "p",
    label: template === null ? null : { template, values: [] as string[] },
  });

  it("drops a close-match label: the heading is the label", () => {
    expect(underCloseHeading(card("close-match")).label).toBeNull();
  });

  it("keeps any other label, and a card with none", () => {
    expect(underCloseHeading(card("price-far")).label).toEqual({ template: "price-far", values: [] });
    expect(underCloseHeading(card(null)).label).toBeNull();
  });
});
