/**
 * Canonical category/occasion taxonomy (YOY-31). One open vocabulary on both
 * sides of a hard filter cannot stay aligned across model releases: the first
 * live regeneration filtered every candidate set to nothing because enrichment
 * said "dresses" while intent said "dress". This module is the single owner of
 * both vocabularies — enrichment and intent schemas pin their enums here, and
 * both parse sites normalize into these sets before any value is stored or
 * filtered on. Nothing else may define its own list.
 */

/** Canonical product categories: singular lowercase English tokens. */
export const CANONICAL_CATEGORIES = [
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
] as const;

/** Canonical occasions: lowercase English tokens. */
export const CANONICAL_OCCASIONS = [
  "casual",
  "work",
  "evening",
  "wedding",
  "beach",
  "sport",
  "other",
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];
export type CanonicalOccasion = (typeof CANONICAL_OCCASIONS)[number];

/**
 * Category groups (YOY-35 AC-5): parent → members a PARENT constraint also
 * matches. Matching is one-directional — a shopper asking for the parent
 * ("shoes") accepts any member, but a child constraint ("sneakers") stays
 * exact, so a child never appears as another child's member. coat ↔ jacket is
 * a symmetric pair: each accepts the other.
 */
export const CATEGORY_GROUPS: Partial<
  Record<CanonicalCategory, readonly CanonicalCategory[]>
> = {
  shoes: ["shoes", "sneakers", "boots"],
  accessories: ["accessories", "jewelry"],
  coat: ["coat", "jacket"],
  jacket: ["jacket", "coat"],
};

/**
 * Expand one category constraint into every category it matches: the group's
 * members when the (normalized-case) constraint is a group parent, else just
 * itself. Both retrieval's category filter and the eval's violation check
 * expand through here, so filter and scorecard agree on what a constraint
 * admits.
 */
export function expandCategoryConstraint(category: string): string[] {
  const token = category.trim().toLowerCase();
  const members = CATEGORY_GROUPS[token as CanonicalCategory];
  return members === undefined ? [token] : [...members];
}

/**
 * Small synonym maps folding common near-misses into the canonical sets.
 * Keys are compared after lowercase/trim and again after singularizing, so
 * one singular entry ("sandal") also covers its plural ("sandals").
 */
const CATEGORY_SYNONYMS: Record<string, CanonicalCategory> = {
  gown: "dress",
  outerwear: "coat",
  blazer: "jacket",
  trouser: "pants",
  jean: "pants",
  legging: "pants",
  shoe: "shoes",
  heel: "shoes",
  sandal: "shoes",
  boot: "boots",
  sneaker: "sneakers",
  trainer: "sneakers",
  handbag: "bag",
  purse: "bag",
  clutch: "bag",
  tote: "bag",
  jewellery: "jewelry",
  accessory: "accessories",
  swimsuit: "swimwear",
  bikini: "swimwear",
  sweater: "top",
  blouse: "top",
  shirt: "top",
  "t-shirt": "top",
  tee: "top",
  cardigan: "top",
  hoodie: "top",
};

const OCCASION_SYNONYMS: Record<string, CanonicalOccasion> = {
  gala: "evening",
  party: "evening",
  cocktail: "evening",
  date: "evening",
  "night out": "evening",
  formal: "evening",
  office: "work",
  business: "work",
  everyday: "casual",
  daily: "casual",
  gym: "sport",
  workout: "sport",
  athletic: "sport",
  vacation: "beach",
  resort: "beach",
};

/**
 * Map one raw token into a canonical set: lowercase, trim, exact/synonym
 * lookup, then the same lookups again on naive singular forms ("dresses" →
 * "dress", "coats" → "coat"). Returns null when nothing maps — the caller
 * owns the fallback (`other` for enrichment storage, no constraint for
 * intent).
 */
function normalizeToken<T extends string>(
  raw: string,
  canonical: readonly T[],
  synonyms: Record<string, T>,
): T | null {
  const token = raw.trim().toLowerCase();
  const candidates = [token];
  if (token.endsWith("ies")) {
    candidates.push(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("es")) {
    candidates.push(token.slice(0, -2));
  }
  if (token.endsWith("s")) {
    candidates.push(token.slice(0, -1));
  }
  for (const candidate of candidates) {
    if ((canonical as readonly string[]).includes(candidate)) {
      return candidate as T;
    }
    const synonym = synonyms[candidate];
    if (synonym !== undefined) {
      return synonym;
    }
  }
  return null;
}

/** Normalize one raw category value; null when unmappable. */
export function normalizeCategory(raw: string): CanonicalCategory | null {
  return normalizeToken(raw, CANONICAL_CATEGORIES, CATEGORY_SYNONYMS);
}

/** Normalize one raw occasion value; null when unmappable. */
export function normalizeOccasion(raw: string): CanonicalOccasion | null {
  return normalizeToken(raw, CANONICAL_OCCASIONS, OCCASION_SYNONYMS);
}
