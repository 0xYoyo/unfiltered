import { describe, expect, it } from "vitest";

import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  normalizeCategory,
  normalizeOccasion,
} from "../src/index.js";

// The canonical taxonomy and its normalization map (YOY-31 AC-1, AC-4, AC-7):
// both vocabularies live in one module, and messy-but-mappable values fold
// into them instead of leaking free text to either side of a hard filter.

describe("canonical sets (AC-1)", () => {
  it("covers the seed/test catalog domain, singular lowercase, plus other", () => {
    expect(CANONICAL_CATEGORIES).toEqual([
      "dress",
      "top",
      "skirt",
      "pants",
      "coat",
      "jacket",
      "shoes",
      "boots",
      "sneakers",
      "bag",
      "jewelry",
      "accessories",
      "swimwear",
      "other",
    ]);
    expect(CANONICAL_OCCASIONS).toEqual([
      "casual",
      "work",
      "evening",
      "wedding",
      "beach",
      "sport",
      "other",
    ]);
  });
});

describe("normalizeCategory (AC-4)", () => {
  it("passes canonical tokens through, case- and whitespace-insensitively", () => {
    expect(normalizeCategory("dress")).toBe("dress");
    expect(normalizeCategory(" Dress ")).toBe("dress");
    expect(normalizeCategory("SHOES")).toBe("shoes");
    expect(normalizeCategory("accessories")).toBe("accessories");
    expect(normalizeCategory("other")).toBe("other");
  });

  it("singularizes plurals onto canonical tokens", () => {
    expect(normalizeCategory("dresses")).toBe("dress");
    expect(normalizeCategory("coats")).toBe("coat");
    expect(normalizeCategory("skirts")).toBe("skirt");
    expect(normalizeCategory("jackets")).toBe("jacket");
    // Canonical plurals stay themselves — singularization must not wreck them.
    expect(normalizeCategory("pants")).toBe("pants");
    expect(normalizeCategory("boots")).toBe("boots");
    expect(normalizeCategory("sneakers")).toBe("sneakers");
  });

  it("folds synonyms — singular or plural — onto canonical tokens", () => {
    expect(normalizeCategory("gown")).toBe("dress");
    expect(normalizeCategory("gowns")).toBe("dress");
    expect(normalizeCategory("outerwear")).toBe("coat");
    expect(normalizeCategory("accessory")).toBe("accessories");
    expect(normalizeCategory("heels")).toBe("shoes");
    expect(normalizeCategory("jeans")).toBe("pants");
    expect(normalizeCategory("sweater")).toBe("top");
    expect(normalizeCategory("swimsuit")).toBe("swimwear");
  });

  it("returns null for unmappable values — the site owns the fallback", () => {
    expect(normalizeCategory("widget")).toBeNull();
    expect(normalizeCategory("")).toBeNull();
    expect(normalizeCategory("שמלה")).toBeNull(); // NG-1: no Hebrew tokens
  });
});

describe("normalizeOccasion (AC-4)", () => {
  it("passes canonical tokens through and folds synonyms", () => {
    expect(normalizeOccasion("wedding")).toBe("wedding");
    expect(normalizeOccasion(" Evening ")).toBe("evening");
    expect(normalizeOccasion("gala")).toBe("evening");
    expect(normalizeOccasion("party")).toBe("evening");
    expect(normalizeOccasion("parties")).toBe("evening");
    expect(normalizeOccasion("cocktail")).toBe("evening");
    expect(normalizeOccasion("office")).toBe("work");
    expect(normalizeOccasion("gym")).toBe("sport");
    expect(normalizeOccasion("everyday")).toBe("casual");
  });

  it("returns null for unmappable values", () => {
    expect(normalizeOccasion("brunch")).toBeNull();
    expect(normalizeOccasion("")).toBeNull();
  });
});
