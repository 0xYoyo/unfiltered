import { describe, expect, it } from "vitest";

import {
  chipLabel,
  chipLabelParts,
  isNegationChip,
} from "../../widget/src/format";
import { buildSearchParams } from "../../widget/src/search-client";
import { STRING_CATALOG, WIDGET_LOCALES } from "../../widget/src/strings";
import {
  fixtureOutcome,
  parseFixtureRemovedChips,
  selectFixture,
  withoutRemovedChips,
} from "./fixture-mode.server";
import { playgroundSearchUrl } from "./search-client";

/**
 * Engine v2 chips on the clients (YOY-149 AC-15 client half, AC-16): the
 * labels both widget paths and the playground draw from the shared
 * `chipLabel`, the `removedChips` wire both clients send, and the
 * playground fixture that answers a removal. The rendered surfaces are
 * proven in the Playwright lane (widget/test-ui/v2-chips.spec.ts,
 * app/playground/test-ui/v2-chips.spec.ts).
 */

const money = (locale: "en" | "he", amount: number, currency: string) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);

describe("v2 chip labels (AC-16)", () => {
  it("price chips show the shopper's number with its currency symbol", () => {
    const cap = { field: "priceMax", value: "400", currency: "ILS" };
    const floor = { field: "priceMin", value: "150", currency: "USD" };
    expect(chipLabel(cap)).toBe(`Under ${money("en", 400, "ILS")}`);
    expect(chipLabel(cap)).toContain("₪");
    expect(chipLabel(floor)).toBe(`Over ${money("en", 150, "USD")}`);
    expect(chipLabel(cap, { locale: "he" })).toBe(
      `עד ${money("he", 400, "ILS")}`,
    );
    expect(chipLabel(floor, { locale: "he" })).toBe(
      `מעל ${money("he", 150, "USD")}`,
    );
  });

  it("a v2 price chip with no currency shows the number alone", () => {
    expect(chipLabel({ field: "priceMax", value: "400" })).toBe("Under 400");
    expect(chipLabel({ field: "priceMax", value: "400" }, { locale: "he" })).toBe(
      "עד 400",
    );
  });

  it("an unknown currency code falls back to number and code", () => {
    expect(
      chipLabel({ field: "priceMax", value: "400", currency: "NOPE" }),
    ).toBe("Under 400 NOPE");
  });

  it("size, availability and exclude read in both chrome languages", () => {
    expect(chipLabel({ field: "size", value: "M" })).toBe("Size M");
    expect(chipLabel({ field: "size", value: "M" }, { locale: "he" })).toBe(
      "מידה M",
    );
    expect(chipLabel({ field: "availability", value: "in stock" })).toBe(
      "In stock",
    );
    expect(
      chipLabel({ field: "availability", value: "in stock" }, { locale: "he" }),
    ).toBe("במלאי");
    expect(chipLabelParts({ field: "exclude", value: "black" })).toEqual({
      negator: "Not",
      value: "black",
    });
    // The excluded term renders as the shopper typed it — Hebrew included.
    expect(
      chipLabelParts({ field: "exclude", value: "שחור" }, { locale: "he" }),
    ).toEqual({ negator: "לא", value: "שחור" });
  });

  it("exclude is an exclusion chip on every surface", () => {
    expect(isNegationChip({ field: "exclude" })).toBe(true);
    expect(isNegationChip({ field: "size" })).toBe(false);
  });

  it("the chip words live in the catalog, with the same keys in EN and HE", () => {
    const keys = [
      "chipPriceMax",
      "chipPriceMin",
      "chipSize",
      "chipInStock",
      "chipNegator",
    ] as const;
    for (const locale of WIDGET_LOCALES) {
      for (const key of keys) {
        expect(STRING_CATALOG[locale][key].trim(), `${locale}.${key}`).not.toBe(
          "",
        );
      }
    }
    expect(Object.keys(STRING_CATALOG.he).sort()).toEqual(
      Object.keys(STRING_CATALOG.en).sort(),
    );
    for (const key of keys) {
      expect(STRING_CATALOG.he[key], `he.${key}`).not.toBe(
        STRING_CATALOG.en[key],
      );
    }
  });
});

describe("removedChips on the wire (AC-15)", () => {
  const removed = [
    { field: "priceMax" as const, value: "400", currency: "ILS" },
    { field: "exclude" as const, value: "black" },
  ];

  it("the widget sends the whole chain as JSON", () => {
    const params = buildSearchParams("dress under 400", "s-1", {
      removedChips: removed,
      paging: { page: 1, pageSize: 24 },
    });
    expect(JSON.parse(params.get("removedChips") ?? "null")).toEqual([
      { field: "priceMax", value: "400" },
      { field: "exclude", value: "black" },
    ]);
    expect(params.get("page")).toBe("1");
  });

  it("an empty chain is not sent", () => {
    expect(
      buildSearchParams("dress", "s-1", { removedChips: [] }).has(
        "removedChips",
      ),
    ).toBe(false);
  });

  it("the playground sends it the same way", () => {
    const url = new URL(
      playgroundSearchUrl({
        query: "budget dress",
        preview: false,
        sessionId: "s-1",
        removedChips: removed,
        paging: { page: 1, pageSize: 24 },
      }),
      "http://localhost",
    );
    expect(JSON.parse(url.searchParams.get("removedChips") ?? "null")).toEqual([
      { field: "priceMax", value: "400" },
      { field: "exclude", value: "black" },
    ]);
  });

  it("a keystroke preview carries neither a page nor a previous query", () => {
    const url = new URL(
      playgroundSearchUrl({
        query: "budget dress",
        preview: true,
        sessionId: "s-1",
        previousQuery: "budget dress",
        paging: { page: 1, pageSize: 24 },
      }),
      "http://localhost",
    );
    expect(url.searchParams.get("mode")).toBe("preview");
    expect(url.searchParams.has("previousQuery")).toBe(false);
    expect(url.searchParams.has("page")).toBe(false);
  });
});

describe("the v2-budget playground fixture", () => {
  it("is selected by a submitted 'budget' query, never by a preview", () => {
    expect(selectFixture("budget dress under 400", false)).toBe("v2-budget");
    expect(selectFixture("budget dress under 400", true)).toBe("preview");
  });

  it("carries every chip field, prices under the cap", () => {
    const body = fixtureOutcome("v2-budget").body!;
    expect(body.chips.map((chip) => chip.field)).toEqual([
      "priceMax",
      "size",
      "availability",
      "exclude",
    ]);
    for (const result of body.results) {
      expect(result.priceMin).toBeLessThanOrEqual(400);
    }
  });

  it("answers a removal with those chips gone and the capped product back", () => {
    const outcome = withoutRemovedChips(fixtureOutcome("v2-budget"), [
      { field: "priceMax", value: "400" },
      { field: "size", value: "M" },
    ]);
    expect(outcome.body!.chips.map((chip) => chip.field)).toEqual([
      "availability",
      "exclude",
    ]);
    expect(
      outcome.body!.results.some((result) => result.priceMin > 400),
    ).toBe(true);
  });

  it("reads removedChips leniently", () => {
    expect(parseFixtureRemovedChips(null)).toBeNull();
    expect(parseFixtureRemovedChips("not json")).toBeNull();
    expect(parseFixtureRemovedChips('{"field":"size"}')).toBeNull();
    expect(
      parseFixtureRemovedChips('[{"field":"size","value":"M"},{"field":1}]'),
    ).toEqual([{ field: "size", value: "M" }]);
  });
});
