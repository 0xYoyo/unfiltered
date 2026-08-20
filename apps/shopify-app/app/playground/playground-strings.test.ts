import { describe, expect, it } from "vitest";

import {
  PLAYGROUND_LOCALES,
  PLAYGROUND_STRING_CATALOG,
  getPlaygroundStrings,
  localeDirection,
  localeFromAcceptLanguage,
  resolveChromeLocale,
  resolvePlaygroundLocale,
} from "./strings";

/**
 * The playground string catalog and chrome-language resolution (YOY-92
 * AC-3). The interface already makes a missing key a compile error; these
 * assert the runtime facts a type cannot: that no entry is empty, that no
 * Hebrew entry was left in English, and that the language a request resolves
 * to is the one the visitor asked for.
 */

describe("string catalog parity", () => {
  it("has the same keys in every locale", () => {
    const [reference, ...rest] = PLAYGROUND_LOCALES.map((locale) =>
      Object.keys(PLAYGROUND_STRING_CATALOG[locale]).sort(),
    );
    for (const keys of rest) {
      expect(keys).toEqual(reference);
    }
  });

  it("has a non-empty string for every key in every locale", () => {
    for (const locale of PLAYGROUND_LOCALES) {
      for (const [key, value] of Object.entries(
        PLAYGROUND_STRING_CATALOG[locale],
      )) {
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("translates the Hebrew set rather than copying the English one", () => {
    const en = PLAYGROUND_STRING_CATALOG.en;
    const he = PLAYGROUND_STRING_CATALOG.he;
    const hebrew = /[֐-׿]/;

    for (const [key, value] of Object.entries(he)) {
      // Three keys are correctly identical or Latin by design: the product
      // name is a proper noun, the toggle label names the other language,
      // and the store title template is two proper nouns around a dash
      // ("{name} — Unfiltered") with nothing in it to translate.
      if (
        key === "productName" ||
        key === "languageToggleTarget" ||
        key === "storeTitle"
      ) {
        continue;
      }
      expect(value, `he.${key} is still the English string`).not.toBe(
        en[key as keyof typeof en],
      );
      expect(hebrew.test(value), `he.${key} carries no Hebrew`).toBe(true);
    }
  });
});

describe("chrome language resolution", () => {
  it("maps locale tokens onto a supported language", () => {
    expect(resolvePlaygroundLocale("he")).toBe("he");
    expect(resolvePlaygroundLocale("he-IL")).toBe("he");
    expect(resolvePlaygroundLocale("HE")).toBe("he");
    expect(resolvePlaygroundLocale("en-GB")).toBe("en");
    expect(resolvePlaygroundLocale("fr")).toBe("en");
    expect(resolvePlaygroundLocale(null)).toBe("en");
  });

  it("gives each language its direction", () => {
    expect(localeDirection("he")).toBe("rtl");
    expect(localeDirection("en")).toBe("ltr");
  });

  it("prefers ?lang= over Accept-Language (AC-3)", () => {
    expect(
      resolveChromeLocale(new URLSearchParams("lang=he"), "en-US,en;q=0.9"),
    ).toBe("he");
    expect(
      resolveChromeLocale(new URLSearchParams("lang=en"), "he-IL,he;q=0.9"),
    ).toBe("en");
  });

  it("falls through to Accept-Language when ?lang= names no supported language", () => {
    expect(
      resolveChromeLocale(new URLSearchParams("lang=fr"), "he-IL,he;q=0.9"),
    ).toBe("he");
  });

  it("falls back to Accept-Language, then English", () => {
    expect(resolveChromeLocale(new URLSearchParams(), "he-IL,he;q=0.9")).toBe(
      "he",
    );
    expect(resolveChromeLocale(new URLSearchParams(), null)).toBe("en");
  });

  it("reads Accept-Language by q-value, then by order", () => {
    expect(localeFromAcceptLanguage("he-IL,he;q=0.9,en;q=0.8")).toBe("he");
    expect(localeFromAcceptLanguage("en;q=0.8,he;q=0.9")).toBe("he");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,he;q=0.5")).toBe("en");
    // A zero q-value is an explicit refusal, not a preference.
    expect(localeFromAcceptLanguage("he;q=0,en;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("")).toBe("en");
  });
});

describe("getPlaygroundStrings", () => {
  it("returns the catalog for the resolved language", () => {
    expect(getPlaygroundStrings("he").soldOut).toBe(
      PLAYGROUND_STRING_CATALOG.he.soldOut,
    );
  });
});
