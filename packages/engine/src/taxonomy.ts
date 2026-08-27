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

/**
 * Vision-only attribute vocabularies (YOY-121 AC-1; PRD capability 14):
 * the closed value sets the vision pass answers with for the five coverage
 * attributes text enrichment cannot see — `sleeveLength`, `neckline`,
 * `garmentLength`, `pattern`, `materialAppearance`. Committed here, beside
 * the category and occasion sets, for the same reason: the vision schema
 * pins its enums to these lists, the parse site maps answers into them,
 * and nothing else may define its own. Every list carries
 * `VISION_NOT_APPLICABLE`, the answer for an item the attribute does not
 * describe (a bag has no neckline; a plain tee has no pattern) — stored as
 * null, never as a token, so it reaches neither the embedding text nor a
 * filter. The values are those docs/VISION-MODEL.md scored the model on.
 */
export const VISION_NOT_APPLICABLE = "not-applicable";

export const VISION_SLEEVE_LENGTHS = [
  "sleeveless",
  "short",
  "three-quarter",
  "long",
  VISION_NOT_APPLICABLE,
] as const;

export const VISION_NECKLINES = [
  "crew",
  "v-neck",
  "scoop",
  "collar",
  "high-neck",
  "hooded",
  "boat",
  "square",
  "asymmetric",
  "notch",
  "off-shoulder",
  "halter",
  VISION_NOT_APPLICABLE,
] as const;

export const VISION_GARMENT_LENGTHS = [
  "cropped",
  "hip",
  "thigh",
  "mini",
  "knee",
  "midi",
  "maxi",
  "ankle",
  "full",
  VISION_NOT_APPLICABLE,
] as const;

export const VISION_PATTERNS = [
  "solid",
  "stripe",
  "check",
  "floral",
  "animal",
  "graphic",
  "print",
  "colour-block",
  "herringbone",
  "quilted",
  "polka-dot",
  "multi",
  VISION_NOT_APPLICABLE,
] as const;

export const VISION_MATERIAL_APPEARANCES = [
  "cotton",
  "denim",
  "wool",
  "knit",
  "fleece",
  "leather",
  "suede",
  "silk",
  "satin",
  "jersey",
  "linen",
  "lace",
  "velvet",
  "synthetic",
  "canvas",
  "metal",
  "rubber",
  VISION_NOT_APPLICABLE,
] as const;

export type VisionSleeveLength = (typeof VISION_SLEEVE_LENGTHS)[number];
export type VisionNeckline = (typeof VISION_NECKLINES)[number];
export type VisionGarmentLength = (typeof VISION_GARMENT_LENGTHS)[number];
export type VisionPattern = (typeof VISION_PATTERNS)[number];
export type VisionMaterialAppearance =
  (typeof VISION_MATERIAL_APPEARANCES)[number];

/**
 * Map one vision answer into its vocabulary: lowercase, trim, exact match.
 * `VISION_NOT_APPLICABLE` and anything outside the list become null — the
 * stored form of "the attribute does not describe this item" and of an
 * answer the schema should already have rejected.
 */
export function normalizeVisionValue<T extends string>(
  raw: string,
  vocabulary: readonly T[],
): Exclude<T, typeof VISION_NOT_APPLICABLE> | null {
  const token = raw.trim().toLowerCase();
  if (token === VISION_NOT_APPLICABLE) {
    return null;
  }
  return (vocabulary as readonly string[]).includes(token)
    ? (token as Exclude<T, typeof VISION_NOT_APPLICABLE>)
    : null;
}

/**
 * Negated and category-like attributes (YOY-133; PRD §3 amendment (d)).
 *
 * A shopper phrases a good half of the hard queries in the negative — "top,
 * no sleeves", "winter coat, not wool", "jacket, not leather" — and the
 * Constructor-bar set measured 19 leaks across 9 of 30 goldens because a
 * negated material, sleeve, or style was ranking-only. Intent extraction
 * now returns such negations as `attributesExclude`: lowercase English
 * words the shopper ruled out. Both stores exclude a product whose EVIDENCE
 * carries the word (enrichment `styleTags`/`fit`, the title, tags, and
 * description text, plus the vision attribute values), so the filter needs
 * to know which text counts as evidence of "wool" — including the Hebrew
 * "צמר" on a Hebrew-titled product. This lexicon is that bridge: one entry
 * per attribute word the intent side may emit, listing every EN and HE
 * surface form that proves the attribute. A word without an entry still
 * filters — on its own form, singular and plural — so an unlisted negation
 * ("not polyester") is never silently dropped; the entry only widens the
 * evidence across languages and spellings.
 *
 * Generic-store analog (PRD portability rule): the evidence columns are
 * the platform-free snapshot (title, tags, description) and the
 * enrichment row every ingestion adapter fills; nothing here reads a
 * Shopify concept.
 */
export const ATTRIBUTE_EVIDENCE_TERMS: Record<string, readonly string[]> = {
  wool: ["wool", "woolen", "woollen", "צמר"],
  cashmere: ["cashmere", "קשמיר"],
  leather: ["leather", "עור"],
  suede: ["suede", "זמש"],
  fur: ["fur", "פרווה"],
  cotton: ["cotton", "כותנה"],
  linen: ["linen", "פשתן"],
  silk: ["silk", "משי"],
  satin: ["satin", "סאטן"],
  velvet: ["velvet", "קטיפה"],
  lace: ["lace", "תחרה"],
  denim: ["denim", "jeans", "ג'ינס", "גינס"],
  polyester: ["polyester", "פוליאסטר"],
  nylon: ["nylon", "ניילון"],
  sleeves: ["sleeve", "sleeves", "שרוול", "שרוולים"],
  hood: ["hood", "hooded", "קפוצ'ון", "קפוצון", "ברדס"],
  pockets: ["pocket", "pockets", "כיס", "כיסים"],
  zipper: ["zipper", "zip", "רוכסן"],
  buttons: ["button", "buttons", "כפתור", "כפתורים"],
  collar: ["collar", "צווארון"],
  heels: ["heel", "heels", "עקב", "עקבים"],
  print: ["print", "printed", "הדפס", "מודפס", "מודפסת"],
  stripes: ["stripe", "stripes", "striped", "פסים"],
  sequins: ["sequin", "sequins", "sequined", "פאייטים"],
  logo: ["logo", "לוגו"],
  bridal: ["bridal", "bride", "brides", "כלה", "כלות"],
};

/**
 * Category-like attributes (YOY-133 AC-3): the closed set an intent may
 * REQUIRE through `attributesInclude`. "wedding dress" / "שמלת כלה" is not
 * `category=dress, occasion=wedding` — that is "dress for a wedding", the
 * guest's query — but the bridal category-like intent: the product IS or
 * IS NOT a bridal gown, exactly as it is or is not a dress. A positive
 * evidence filter kills recall on a sparse catalog when the model is free
 * to invent one ("linen shirt" → require linen), so the schema pins this
 * list as an enum and the parse site drops anything outside it; the
 * exclusion side stays open. Grow it only for another attribute that
 * behaves like a category, never for a material or a mood.
 */
export const CATEGORY_LIKE_ATTRIBUTES = ["bridal"] as const;

export type CategoryLikeAttribute = (typeof CATEGORY_LIKE_ATTRIBUTES)[number];

/**
 * Fold one raw attribute word from the model into its lexicon key: lowercase,
 * trimmed, a listed surface form ("sleeve", "woollen") converging on its
 * entry ("sleeves", "wool"), an unlisted word kept as-is. Null for an empty
 * or multi-word value — a phrase is not an attribute word, and a filter on
 * it would match nothing.
 */
export function normalizeAttributeWord(raw: string): string | null {
  const word = raw.trim().toLowerCase();
  if (word === "" || /\s/.test(word)) {
    return null;
  }
  if (word in ATTRIBUTE_EVIDENCE_TERMS) {
    return word;
  }
  for (const [key, forms] of Object.entries(ATTRIBUTE_EVIDENCE_TERMS)) {
    if (forms.includes(word)) {
      return key;
    }
  }
  return word;
}

/**
 * Every surface form that is evidence of one attribute word: the lexicon
 * entry when there is one, else the word itself with its naive singular
 * and plural, so an unlisted word still matches "pocket" and "pockets".
 * Distinct, lowercase; the stores match each as a whole word.
 */
export function attributeEvidenceTerms(word: string): string[] {
  const key = normalizeAttributeWord(word);
  if (key === null) {
    return [];
  }
  const listed = ATTRIBUTE_EVIDENCE_TERMS[key];
  if (listed !== undefined) {
    return [...listed];
  }
  const forms = new Set<string>([key]);
  if (key.endsWith("s")) {
    forms.add(key.slice(0, -1));
  } else {
    forms.add(`${key}s`);
  }
  return [...forms].filter((form) => form !== "");
}

/** Normalize one raw category-like attribute; null when outside the closed set. */
export function normalizeCategoryLikeAttribute(
  raw: string,
): CategoryLikeAttribute | null {
  const word = normalizeAttributeWord(raw);
  return word !== null &&
    (CATEGORY_LIKE_ATTRIBUTES as readonly string[]).includes(word)
    ? (word as CategoryLikeAttribute)
    : null;
}
