import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_EVIDENCE_TERMS,
  attributeEvidenceTerms,
  CANONICAL_CATEGORIES,
  CATEGORY_LIKE_ATTRIBUTES,
  normalizeAttributeWord,
  normalizeCategoryLikeAttribute,
  CANONICAL_OCCASIONS,
  CATEGORY_GROUPS,
  expandCategoryConstraint,
  normalizeCategory,
  normalizeOccasion,
  normalizeVisionValue,
  VISION_GARMENT_LENGTHS,
  VISION_MATERIAL_APPEARANCES,
  VISION_NECKLINES,
  VISION_NOT_APPLICABLE,
  VISION_PATTERNS,
  VISION_SLEEVE_LENGTHS,
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

describe("category groups (YOY-35 AC-5)", () => {
  it("declares exactly the specified parent → members map", () => {
    expect(CATEGORY_GROUPS).toEqual({
      shoes: ["shoes", "sneakers", "boots"],
      accessories: ["accessories", "jewelry"],
      coat: ["coat", "jacket"],
      jacket: ["jacket", "coat"],
    });
  });

  it("expands a parent constraint to every member — the g07 and g20 shapes", () => {
    // g07: a "shoes" constraint must admit the white sneakers.
    expect(expandCategoryConstraint("shoes")).toEqual([
      "shoes",
      "sneakers",
      "boots",
    ]);
    // g20: an "accessories" constraint must admit jewelry.
    expect(expandCategoryConstraint("accessories")).toEqual([
      "accessories",
      "jewelry",
    ]);
    expect(expandCategoryConstraint(" Shoes ")).toEqual([
      "shoes",
      "sneakers",
      "boots",
    ]);
  });

  it("keeps coat ↔ jacket symmetric", () => {
    expect(expandCategoryConstraint("coat")).toEqual(["coat", "jacket"]);
    expect(expandCategoryConstraint("jacket")).toEqual(["jacket", "coat"]);
  });

  it("keeps child constraints exact — sneakers means sneakers", () => {
    expect(expandCategoryConstraint("sneakers")).toEqual(["sneakers"]);
    expect(expandCategoryConstraint("boots")).toEqual(["boots"]);
    expect(expandCategoryConstraint("jewelry")).toEqual(["jewelry"]);
    expect(expandCategoryConstraint("dress")).toEqual(["dress"]);
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

// The vision-only vocabularies (YOY-121 AC-1): five closed sets the vision
// pass answers with, each carrying the not-applicable sentinel that parses
// to null so it reaches neither the embedding text nor a filter.
describe("vision vocabularies (YOY-121 AC-1)", () => {
  it("every vocabulary is lowercase, distinct, and carries the not-applicable sentinel", () => {
    for (const vocabulary of [
      VISION_SLEEVE_LENGTHS,
      VISION_NECKLINES,
      VISION_GARMENT_LENGTHS,
      VISION_PATTERNS,
      VISION_MATERIAL_APPEARANCES,
    ]) {
      expect(vocabulary).toContain(VISION_NOT_APPLICABLE);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
      for (const value of vocabulary) {
        expect(value).toBe(value.trim().toLowerCase());
      }
    }
    expect(VISION_SLEEVE_LENGTHS).toEqual([
      "sleeveless",
      "short",
      "three-quarter",
      "long",
      "not-applicable",
    ]);
  });

  it("normalizeVisionValue maps in-set answers, and nulls the sentinel and out-of-set values", () => {
    expect(normalizeVisionValue("Long", VISION_SLEEVE_LENGTHS)).toBe("long");
    expect(normalizeVisionValue(" v-neck ", VISION_NECKLINES)).toBe("v-neck");
    expect(normalizeVisionValue("midi", VISION_GARMENT_LENGTHS)).toBe("midi");
    expect(normalizeVisionValue("floral", VISION_PATTERNS)).toBe("floral");
    expect(normalizeVisionValue("leather", VISION_MATERIAL_APPEARANCES)).toBe("leather");
    expect(normalizeVisionValue(VISION_NOT_APPLICABLE, VISION_SLEEVE_LENGTHS)).toBeNull();
    expect(normalizeVisionValue("paisley", VISION_PATTERNS)).toBeNull();
    expect(normalizeVisionValue("", VISION_MATERIAL_APPEARANCES)).toBeNull();
  });
});

describe("attribute evidence lexicon (YOY-133)", () => {
  it("every entry is lowercase, distinct, carries its own key, and names at least one Hebrew form", () => {
    for (const [key, forms] of Object.entries(ATTRIBUTE_EVIDENCE_TERMS)) {
      expect(key, key).toBe(key.toLowerCase());
      expect(forms, key).toContain(key);
      expect(new Set(forms).size, key).toBe(forms.length);
      for (const form of forms) {
        expect(form, `${key}: ${form}`).toBe(form.trim().toLowerCase());
      }
      expect(forms.some((form) => /[\u05D0-\u05EA]/.test(form)), `${key} has no Hebrew form`).toBe(true);
    }
    // The category-like set is a subset of the lexicon: every include has evidence terms.
    for (const word of CATEGORY_LIKE_ATTRIBUTES) {
      expect(ATTRIBUTE_EVIDENCE_TERMS[word], word).toBeDefined();
    }
  });

  it("normalizeAttributeWord folds surface forms onto their key and keeps unlisted words", () => {
    expect(normalizeAttributeWord("Wool")).toBe("wool");
    expect(normalizeAttributeWord("woollen")).toBe("wool");
    expect(normalizeAttributeWord("sleeve")).toBe("sleeves");
    expect(normalizeAttributeWord(" Sleeves ")).toBe("sleeves");
    expect(normalizeAttributeWord("צמר")).toBe("wool");
    expect(normalizeAttributeWord("polyester")).toBe("polyester");
    // Empty and multi-word values are not attribute words.
    expect(normalizeAttributeWord("")).toBeNull();
    expect(normalizeAttributeWord("long sleeve")).toBeNull();
  });

  it("attributeEvidenceTerms lists the lexicon forms, or the word with its singular/plural when unlisted", () => {
    expect(attributeEvidenceTerms("sleeve")).toEqual(["sleeve", "sleeves", "שרוול", "שרוולים"]);
    expect(attributeEvidenceTerms("viscose")).toEqual(["viscose", "viscoses"]);
    expect(attributeEvidenceTerms("pleats")).toEqual(["pleats", "pleat"]);
    expect(attributeEvidenceTerms("")).toEqual([]);
  });

  it("normalizeCategoryLikeAttribute admits only the closed set", () => {
    expect(normalizeCategoryLikeAttribute("Bridal")).toBe("bridal");
    expect(normalizeCategoryLikeAttribute("bride")).toBe("bridal");
    expect(normalizeCategoryLikeAttribute("wool")).toBeNull();
    expect(normalizeCategoryLikeAttribute("linen")).toBeNull();
  });
});
