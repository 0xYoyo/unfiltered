import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { InlineImage, JsonSchema, LlmClient } from "@unfiltered/engine";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  normalizeCategory,
  normalizeOccasion,
  normalizeVisionValue,
  VISION_GARMENT_LENGTHS,
  VISION_MATERIAL_APPEARANCES,
  VISION_NECKLINES,
  VISION_NOT_APPLICABLE,
  VISION_PATTERNS,
  VISION_SLEEVE_LENGTHS,
} from "@unfiltered/engine";
import {
  createGeminiLlmClient,
  geminiModelsFromEnv,
} from "@unfiltered/provider-gemini";

import { createPrismaCostRecorder } from "../ai/cost-recorder.server";
import type { ImageFetch } from "./images.server";
import { globalImageFetch } from "./images.server";

/**
 * Structured attribute record the enrichment step derives per product
 * (YOY-22). Vendor-free: nothing here is Shopify- or Gemini-specific, so the
 * retrieval layer can consume it as-is.
 */
export interface ProductAttributes {
  category: string;
  colors: string[];
  /**
   * The product's primary/displayed colour (YOY-110): the colour named by
   * the title's colourway designator, else the first colour the text states
   * in reading order, else null. Lowercase English. Colour exclusions apply
   * to this alone; `colors` keeps every stated colourway.
   */
  primaryColor: string | null;
  occasions: string[];
  fit: string;
  styleTags: string[];
  seasons: string[];
}

/**
 * The five vision-only coverage attributes (YOY-121 AC-1): what the text
 * cannot say and the images can. Values from the committed vocabularies in
 * the engine's taxonomy; null when vision never ran or the attribute does
 * not describe the item.
 */
export interface VisionOnlyAttributes {
  sleeveLength: string | null;
  neckline: string | null;
  garmentLength: string | null;
  pattern: string | null;
  materialAppearance: string | null;
}

/**
 * The vision pass's own answer (YOY-121 AC-2): the shared enrichment
 * fields as the images show them, plus the five vision-only fields. Never
 * stored as the row's columns directly — merged with the text answer by
 * `mergeAttributes`, and kept raw in `visionAttributes` for re-merging.
 */
export interface VisionAttributes extends VisionOnlyAttributes {
  category: string;
  colors: string[];
  primaryColor: string | null;
  occasions: string[];
  fit: string;
  styleTags: string[];
}

/** The merged record a `ProductEnrichment` row's columns hold. */
export type MergedAttributes = ProductAttributes & VisionOnlyAttributes;

/**
 * The enrichment rule set's version (YOY-110 AC-2), stored on every row.
 * Bump it whenever the prompt, schema, or parse rule changes what a row
 * holds: rows at an older version re-enrich on the next run even when their
 * content is unchanged. Version 1 introduced `primaryColor`; version 2
 * (YOY-121 AC-1) the vision pass and the merged vision-only columns.
 */
export const ENRICHMENT_VERSION = 2;

/**
 * JSON Schema every enrichment completion must satisfy. Passed to the LLM
 * port as the response schema and enforced again locally by
 * `parseEnrichment` — the model's promise to follow a schema is not trusted.
 */
export const ENRICHMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    // category and occasions are pinned to the canonical taxonomy (YOY-31):
    // an out-of-set answer violates the response schema and takes the
    // existing retry/failed path instead of landing free text in the store.
    category: { type: "string", enum: [...CANONICAL_CATEGORIES] },
    colors: { type: "array", items: { type: "string" } },
    // The primary colour as a plain string: "" when the text states no
    // colour. A nullable member is avoided because not every structured-
    // output validator honours `nullable`; parseEnrichment maps "" to null.
    primaryColor: { type: "string" },
    occasions: {
      type: "array",
      items: { type: "string", enum: [...CANONICAL_OCCASIONS] },
    },
    fit: { type: "string" },
    styleTags: { type: "array", items: { type: "string" } },
    seasons: { type: "array", items: { type: "string" } },
  },
  required: [
    "category",
    "colors",
    "primaryColor",
    "occasions",
    "fit",
    "styleTags",
    "seasons",
  ],
};

/** The snapshot fields enrichment reads; a subset of one CatalogProduct row. */
export interface EnrichableProduct {
  productId: string;
  title: string;
  description: string;
  tags: string[];
  productType: string;
  imageAltTexts: string[];
  contentHash: string;
}

/**
 * Prompt over exactly the issue-specified source fields: title, description,
 * tags, product type, and image alt texts. Products may be in any language
 * (e.g. Hebrew); attribute values are normalized to lowercase English so
 * downstream hard filters compare a single vocabulary.
 */
export function buildEnrichmentPrompt(product: EnrichableProduct): string {
  return [
    "Extract structured attributes for this fashion e-commerce product.",
    "The product text may be in any language; answer with lowercase English",
    "attribute values — always translate non-English words into English",
    "(for example שחור → black, ורוד → pink, אפור → gray).",
    `- category must be one of: ${CANONICAL_CATEGORIES.join(", ")}. Use`,
    '  "other" when none fits.',
    `- occasions may only contain: ${CANONICAL_OCCASIONS.join(", ")}. Include`,
    "  an occasion only when the product text itself states or clearly",
    "  implies it; when the text gives no evidence, occasions must be [].",
    "- colors: only colors the product text itself states, each as a plain",
    '  lowercase English color word (e.g. "black", not "noir"). Never invent',
    "  or infer a color; when the text states no color, colors must be [].",
    "- primaryColor: the product's primary/displayed color, chosen by this",
    "  rule: (a) the color named by the title's colorway designator —",
    '  "in <Color>", "- <Color>", "/ <Color>", "(<Color>)" — else (b) the',
    "  first color the product text states in reading order (title, then",
    "  description, then tags). Write it exactly as it appears in colors.",
    '  When the text states no color, primaryColor must be "".',
    "Use empty strings/arrays for the other attributes when the text gives",
    "no evidence for them. Answer as JSON.",
    "",
    `Title: ${product.title}`,
    `Description: ${product.description}`,
    `Tags: ${product.tags.join(", ")}`,
    `Product type: ${product.productType}`,
    `Image alt texts: ${product.imageAltTexts.join(", ")}`,
  ].join("\n");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * The colourway designator shapes a title carries (YOY-110 AC-1 rule a):
 * `Mesh Over Dress in Pink`, `Linen Shirt - Sand`, `Court Sneaker / White`,
 * `Wool Beanie (Black)`. Each captures the designator text after the marker,
 * up to the end of the title (or the closing paren).
 */
const DESIGNATOR_PATTERNS: RegExp[] = [
  /\bin\s+([^\-/()]+?)\s*$/i,
  /\s[-–—]\s*([^\-/()]+?)\s*$/,
  /\s\/\s*([^\-/()]+?)\s*$/,
  /\(([^()]+)\)\s*$/,
];

/**
 * The colour a title's colourway designator names, when it names one of the
 * stated colours (YOY-110 AC-1 rule a). A designator that is not a stated
 * colour ("Dress in Linen") is not a colour designator and yields null, so
 * the fallback rule decides. Lowercase; case-insensitive against `colors`.
 */
export function primaryColorFromTitle(
  title: string,
  colors: string[],
): string | null {
  const stated = colors.map((color) => color.trim().toLowerCase());
  for (const pattern of DESIGNATOR_PATTERNS) {
    const match = pattern.exec(title);
    if (match === null) {
      continue;
    }
    const designator = match[1]!.trim().toLowerCase();
    if (designator === "") {
      continue;
    }
    // Exact colour first ("in Pink"), then a colour the designator contains
    // ("in Dusty Pink" → pink) so a modifier does not hide the colour.
    const exact = stated.find((color) => color === designator);
    if (exact !== undefined) {
      return exact;
    }
    const contained = stated.find(
      (color) =>
        color !== "" && new RegExp(`\\b${escapeRegExp(color)}\\b`).test(designator),
    );
    if (contained !== undefined) {
      return contained;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-validate the model's primary colour against the rule (YOY-110 AC-1):
 * the title's colourway designator wins when it names a stated colour; else
 * the model's answer stands when it is one of the stated colours; else the
 * first stated colour; else null. Never a colour the text does not state.
 */
export function resolvePrimaryColor(
  title: string,
  colors: string[],
  answered: string,
): string | null {
  const fromTitle = primaryColorFromTitle(title, colors);
  if (fromTitle !== null) {
    return fromTitle;
  }
  const stated = colors.map((color) => color.trim().toLowerCase());
  const candidate = answered.trim().toLowerCase();
  if (candidate !== "" && stated.includes(candidate)) {
    return candidate;
  }
  return stated.find((color) => color !== "") ?? null;
}

/**
 * Validate one model completion against the attribute schema and normalize
 * category/occasions into the canonical taxonomy (YOY-31 AC-4) before
 * anything is stored: in-set-but-messy answers ("Dresses", "gala") converge
 * onto canonical tokens; unmappable values become "other" — never free text,
 * so the retrieval side's hard filters always compare one vocabulary.
 * Returns null on any shape violation — the caller owns retry/failure
 * bookkeeping.
 *
 * `primaryColor` is re-validated against the product title (YOY-110 AC-1):
 * see `resolvePrimaryColor`. The title is the only source field the rule
 * reads, so callers pass `{ title }`.
 */
export function parseEnrichment(
  value: unknown,
  source: Pick<EnrichableProduct, "title">,
): ProductAttributes | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string" ||
    typeof record.fit !== "string" ||
    typeof record.primaryColor !== "string" ||
    !isStringArray(record.colors) ||
    !isStringArray(record.occasions) ||
    !isStringArray(record.styleTags) ||
    !isStringArray(record.seasons)
  ) {
    return null;
  }
  return {
    category: normalizeCategory(record.category) ?? "other",
    colors: record.colors,
    primaryColor: resolvePrimaryColor(
      source.title,
      record.colors,
      record.primaryColor,
    ),
    occasions: [
      ...new Set(
        record.occasions.map(
          (occasion) => normalizeOccasion(occasion) ?? "other",
        ),
      ),
    ],
    fit: record.fit,
    styleTags: record.styleTags,
    seasons: record.seasons,
  };
}

/**
 * JSON Schema the vision pass answers with (YOY-121 AC-2): the shared
 * enrichment fields — category, colors, primaryColor, occasions, fit,
 * styleTags — plus the five vision-only fields, each pinned to its
 * committed vocabulary. `seasons` is deliberately absent: it is a text
 * claim, never a visual one. Enforced again locally by
 * `parseVisionAttributes`.
 */
export const VISION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CANONICAL_CATEGORIES] },
    colors: { type: "array", items: { type: "string" } },
    primaryColor: { type: "string" },
    occasions: {
      type: "array",
      items: { type: "string", enum: [...CANONICAL_OCCASIONS] },
    },
    fit: { type: "string" },
    styleTags: { type: "array", items: { type: "string" } },
    sleeveLength: { type: "string", enum: [...VISION_SLEEVE_LENGTHS] },
    neckline: { type: "string", enum: [...VISION_NECKLINES] },
    garmentLength: { type: "string", enum: [...VISION_GARMENT_LENGTHS] },
    pattern: { type: "string", enum: [...VISION_PATTERNS] },
    materialAppearance: {
      type: "string",
      enum: [...VISION_MATERIAL_APPEARANCES],
    },
  },
  required: [
    "category",
    "colors",
    "primaryColor",
    "occasions",
    "fit",
    "styleTags",
    "sleeveLength",
    "neckline",
    "garmentLength",
    "pattern",
    "materialAppearance",
  ],
};

/**
 * The anchored vision prompt (YOY-121 AC-2; PRD capability 14): the
 * product's title, type, and text anchor WHICH item in the photos is for
 * sale, and the model must describe only that item — never the other
 * garments, footwear, or jewelry a model wears, the model, or the
 * background. The wording is the one docs/VISION-MODEL.md measured at 3.4 %
 * contamination, with the "trust the images when the text disagrees" line
 * that made the text-conflict and text-sparse products free.
 */
export function buildVisionPrompt(product: EnrichableProduct): string {
  return [
    "You are labelling ONE fashion e-commerce product for a search index.",
    "The images are the product's own listing photos. They may show a model",
    "wearing OTHER garments, footwear, jewelry or accessories that are NOT",
    "for sale. Describe ONLY the item being sold — the one named by the",
    "title and product type below; ignore other garments, footwear, and",
    "jewelry worn by models in the photos. Never report a colour, pattern,",
    "material or category that belongs to another item in the picture, the",
    "model, or the background. The product text can be sparse or wrong;",
    "when text and images disagree about what you can see, trust the",
    "images. Answer with lowercase English values.",
    `- category: exactly one of ${CANONICAL_CATEGORIES.join(", ")}.`,
    "- colors: the colours ON THE SOLD ITEM only, as plain lowercase English",
    '  colour words (e.g. "black", "navy", "beige"), dominant first; []',
    "  only when the item is not visible.",
    "- primaryColor: the single dominant colour of the sold item, written",
    '  exactly as in colors; "" when colors is [].',
    `- occasions: any of ${CANONICAL_OCCASIONS.join(", ")} the item clearly`,
    "  suits; [] when none is evident.",
    '- fit: how the item fits (e.g. slim, regular, relaxed, oversized); ""',
    "  when not visible or not applicable.",
    "- styleTags: a few lowercase style words the item's look supports",
    "  (e.g. elegant, sporty, minimal, boho); [] when none.",
    `- sleeveLength: one of ${VISION_SLEEVE_LENGTHS.join(", ")}.`,
    `- neckline: one of ${VISION_NECKLINES.join(", ")}.`,
    `- garmentLength: one of ${VISION_GARMENT_LENGTHS.join(", ")}.`,
    `  Use "${VISION_NOT_APPLICABLE}" for shoes, bags, jewelry, accessories`,
    "  and legwear (trousers have no neckline).",
    `- pattern: one of ${VISION_PATTERNS.join(", ")}; "solid" when there is`,
    "  no print.",
    `- materialAppearance: what the material LOOKS like, one of`,
    `  ${VISION_MATERIAL_APPEARANCES.join(", ")}.`,
    "Answer as JSON matching the schema.",
    "",
    `Title: ${product.title}`,
    `Product type: ${product.productType || "(none)"}`,
    `Text: ${product.description || "(none)"}`,
    `Tags: ${product.tags.length > 0 ? product.tags.join(", ") : "(none)"}`,
  ].join("\n");
}

/**
 * Validate one vision completion against `VISION_SCHEMA` and normalize it
 * (YOY-121 AC-2): category and occasions into the canonical taxonomy like
 * the text answer; the five vision-only fields into their vocabularies
 * (`not-applicable` and anything out of set become null); colours
 * lowercased and de-duplicated; `primaryColor` the model's answer when it
 * is one of the answered colours, else the first colour, else null. Returns
 * null on any shape violation — the caller owns retry/failure bookkeeping.
 */
export function parseVisionAttributes(value: unknown): VisionAttributes | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string" ||
    typeof record.fit !== "string" ||
    typeof record.primaryColor !== "string" ||
    typeof record.sleeveLength !== "string" ||
    typeof record.neckline !== "string" ||
    typeof record.garmentLength !== "string" ||
    typeof record.pattern !== "string" ||
    typeof record.materialAppearance !== "string" ||
    !isStringArray(record.colors) ||
    !isStringArray(record.occasions) ||
    !isStringArray(record.styleTags)
  ) {
    return null;
  }
  const colors = [
    ...new Set(
      record.colors.map((color) => color.trim().toLowerCase()).filter((c) => c !== ""),
    ),
  ];
  const answered = record.primaryColor.trim().toLowerCase();
  const primaryColor =
    answered !== "" && colors.includes(answered) ? answered : (colors[0] ?? null);
  return {
    category: normalizeCategory(record.category) ?? "other",
    colors,
    primaryColor,
    occasions: [
      ...new Set(
        record.occasions.map((occasion) => normalizeOccasion(occasion) ?? "other"),
      ),
    ],
    fit: record.fit.trim().toLowerCase(),
    styleTags: record.styleTags.map((tag) => tag.trim().toLowerCase()).filter((t) => t !== ""),
    sleeveLength: normalizeVisionValue(record.sleeveLength, VISION_SLEEVE_LENGTHS),
    neckline: normalizeVisionValue(record.neckline, VISION_NECKLINES),
    garmentLength: normalizeVisionValue(record.garmentLength, VISION_GARMENT_LENGTHS),
    pattern: normalizeVisionValue(record.pattern, VISION_PATTERNS),
    materialAppearance: normalizeVisionValue(
      record.materialAppearance,
      VISION_MATERIAL_APPEARANCES,
    ),
  };
}

/**
 * Merge the text answer with the vision answer into the row's columns
 * (YOY-121 AC-3; PRD capability 14 — "text-derived values win conflicts on
 * factual fields, vision fills gaps"):
 *
 * - category, colors, primaryColor, occasions, fit: the text value wins
 *   when present; vision fills a null/empty one. A text category of
 *   `other` counts as absent — it is `parseEnrichment`'s "nothing mapped"
 *   token, not a claim — so a text-sparse "Gold straps." product takes
 *   `shoes` from the images. `primaryColor` follows `colors`: text states
 *   no colour ⇒ both come from vision.
 * - styleTags: the union, text first, de-duplicated.
 * - seasons: text only (never a visual claim).
 * - the five vision-only fields: from vision, null without it.
 *
 * Null when neither side answered — the row is `failed`. A vision-only
 * record (text failed, images read) is a valid enrichment: the text-sparse
 * catalog is exactly the case the capability exists for.
 */
export function mergeAttributes(
  text: ProductAttributes | null,
  vision: VisionAttributes | null,
): MergedAttributes | null {
  if (text === null && vision === null) {
    return null;
  }
  const textCategory =
    text !== null && text.category !== "other" ? text.category : null;
  const textColors = text !== null && text.colors.length > 0 ? text.colors : null;
  return {
    category: textCategory ?? vision?.category ?? text?.category ?? "other",
    colors: textColors ?? vision?.colors ?? [],
    primaryColor:
      textColors !== null
        ? (text?.primaryColor ?? null)
        : (vision?.primaryColor ?? null),
    occasions:
      text !== null && text.occasions.length > 0
        ? text.occasions
        : (vision?.occasions ?? []),
    fit: text !== null && text.fit !== "" ? text.fit : (vision?.fit ?? ""),
    styleTags: [...new Set([...(text?.styleTags ?? []), ...(vision?.styleTags ?? [])])],
    seasons: text?.seasons ?? [],
    sleeveLength: vision?.sleeveLength ?? null,
    neckline: vision?.neckline ?? null,
    garmentLength: vision?.garmentLength ?? null,
    pattern: vision?.pattern ?? null,
    materialAppearance: vision?.materialAppearance ?? null,
  };
}

/**
 * The vision pass's dependencies (YOY-121 AC-2): the vision-model port and
 * the fetcher that re-reads the product's image bytes (`ProductImage` keeps
 * hashes only, never bytes). Absent from `enrichCatalog`, no vision call
 * is made and stored vision answers are kept as they are.
 */
export interface VisionPass {
  llm: LlmClient;
  /** Defaults to the platform fetch; the public paths pass the polite fetcher. */
  fetchImage?: ImageFetch;
}

/** Outcome counts of the vision pass within one enrichment run (AC-6). */
export interface VisionResult {
  /** Products whose images were sent to the model (enriched or failed). */
  analysed: number;
  /** Products with images whose hashes matched the stored key: no call. */
  cached: number;
  /** Products whose two attempts both failed, or whose images could not be fetched. */
  failed: number;
  /** Ledger cost of this run's `vision` calls for the shop, USD. */
  costUsd: number;
}

/** The `ProductImage` slice the vision pass reads: URL and hash, position order. */
interface VisionImage {
  url: string;
  contentHash: string;
}

/** Content-type header → InlineImage MIME type; anything not an image type is treated as JPEG. */
function imageMimeType(response: Response): string {
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return contentType.startsWith("image/") ? contentType : "image/jpeg";
}

/** Re-read the product's images as inline bytes; a failed fetch drops that image. */
async function fetchInlineImages(
  fetchImage: ImageFetch,
  images: VisionImage[],
): Promise<InlineImage[]> {
  const inline: InlineImage[] = [];
  for (const image of images) {
    try {
      const response = await fetchImage(image.url);
      if (!response.ok) {
        continue;
      }
      inline.push({
        mimeType: imageMimeType(response),
        data: new Uint8Array(await response.arrayBuffer()),
      });
    } catch {
      // A transport failure on one image loses that image for this pass only.
    }
  }
  return inline;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Group the shop's `ProductImage` rows by product, in position order. */
async function loadVisionImages(
  db: PrismaClient,
  shopDomain: string,
): Promise<Map<string, VisionImage[]>> {
  const rows = await db.productImage.findMany({
    where: { shopDomain },
    orderBy: [{ productId: "asc" }, { position: "asc" }],
    select: { productId: true, url: true, contentHash: true },
  });
  const byProduct = new Map<string, VisionImage[]>();
  for (const row of rows) {
    const list = byProduct.get(row.productId) ?? [];
    list.push({ url: row.url, contentHash: row.contentHash });
    byProduct.set(row.productId, list);
  }
  return byProduct;
}

/**
 * A stored `textAttributes` JSON back as a typed record; null when absent or
 * malformed. The column holds the PARSED answer, whose `primaryColor` is
 * null when the text stated no colour, while `parseEnrichment` validates
 * the model's raw shape (a string, "" for none) — so the null is mapped
 * back to "" before re-validation. Without that, a colourless product's
 * text answer read back as malformed and was silently dropped on the next
 * vision-only re-merge (found by the YOY-122 eval fixtures).
 */
export function textAttributesFromStored(
  value: Prisma.JsonValue | null | undefined,
  product: Pick<EnrichableProduct, "title">,
): ProductAttributes | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return parseEnrichment(
    { ...record, primaryColor: record.primaryColor ?? "" },
    product,
  );
}

/**
 * A stored `visionAttributes` JSON back as a typed record; null when absent
 * or malformed. Same rule as `textAttributesFromStored`: the stored answer
 * carries null for "no colour" and for a not-applicable coverage field (a
 * pair of trousers has no neckline), which `parseVisionAttributes` only
 * accepts in their raw string forms — so each null is mapped back before
 * re-validation.
 */
export function visionAttributesFromStored(
  value: Prisma.JsonValue | null | undefined,
): VisionAttributes | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return parseVisionAttributes({
    ...record,
    primaryColor: record.primaryColor ?? "",
    sleeveLength: record.sleeveLength ?? VISION_NOT_APPLICABLE,
    neckline: record.neckline ?? VISION_NOT_APPLICABLE,
    garmentLength: record.garmentLength ?? VISION_NOT_APPLICABLE,
    pattern: record.pattern ?? VISION_NOT_APPLICABLE,
    materialAppearance: record.materialAppearance ?? VISION_NOT_APPLICABLE,
  });
}

/** A source answer as the JSON column value: the record, or SQL NULL. */
function jsonColumn(
  value: ProductAttributes | VisionAttributes | null,
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonObject);
}

/** Outcome counts of one enrichment run. */
export interface EnrichResult {
  enriched: number;
  cached: number;
  failed: number;
  /** Present exactly when a vision pass was configured (YOY-121 AC-6). */
  vision?: VisionResult;
}

/**
 * Enrich one shop's catalog snapshot: for every CatalogProduct row whose
 * contentHash has no matching ProductEnrichment row, complete the attribute
 * record through the engine's LLM port and upsert it.
 *
 * Cached by snapshot content hash (AC-3): a product whose hash already has an
 * enrichment row — enriched or failed — is skipped, so re-running over an
 * unchanged catalog performs zero LLM calls. A failed row retries only after
 * the product's content changes.
 *
 * Versioned (YOY-110 AC-2): the cache hit also requires the row's
 * `enrichmentVersion` to equal ENRICHMENT_VERSION, so a rule change re-runs
 * every row once — including rows written before versioning, which carry 0.
 *
 * Invalid output (schema-violating JSON, or a per-call adapter error) is
 * retried once, then the product is marked failed without blocking the batch
 * (AC-2). Every call goes through `llm` with operation "enrichment", so a
 * metered adapter lands one cost-ledger row per call (AC-4).
 *
 * Vision pass (YOY-121 AC-2, AC-5), when `vision` is given: every product
 * with ≥ 1 `ProductImage` whose current image hashes (position order)
 * differ from the row's `visionImageHashes` has its images re-read and
 * sent — one call per product, up to four images — through `vision.llm`
 * with operation "vision" and the anchored prompt. Two attempts, then
 * `visionStatus: failed` with the hashes recorded, so a model failure
 * retries only when an image changes (as text failures retry only on a
 * content change); images that cannot be fetched at all make no call and
 * leave the key untouched, so the next run tries again. Equal hashes make
 * zero vision calls. The text and vision answers are each kept raw
 * (`textAttributes`, `visionAttributes`) and the row's columns are their
 * merge (`mergeAttributes`, AC-3), so re-running either side re-merges
 * against the other's actual answer. A product whose text is cached and
 * whose images are unchanged is not touched at all.
 */
export async function enrichCatalog({
  db,
  shopDomain,
  llm,
  vision,
}: {
  db: PrismaClient;
  shopDomain: string;
  llm: LlmClient;
  vision?: VisionPass;
}): Promise<EnrichResult> {
  const startedAt = new Date();
  const products = await db.catalogProduct.findMany({
    where: { shopDomain },
    orderBy: { productId: "asc" },
  });
  const existing = await db.productEnrichment.findMany({ where: { shopDomain } });
  const existingByProduct = new Map(existing.map((row) => [row.productId, row]));
  const imagesByProduct =
    vision === undefined ? new Map<string, VisionImage[]>() : await loadVisionImages(db, shopDomain);
  const fetchImage = vision?.fetchImage ?? globalImageFetch;

  const result: EnrichResult = { enriched: 0, cached: 0, failed: 0 };
  const visionCounts: VisionResult = { analysed: 0, cached: 0, failed: 0, costUsd: 0 };

  for (const product of products) {
    const row = existingByProduct.get(product.productId);
    const textCached =
      row !== undefined &&
      row.enrichmentVersion === ENRICHMENT_VERSION &&
      row.contentHash === product.contentHash;
    const images = imagesByProduct.get(product.productId) ?? [];
    const imageHashes = images.map((image) => image.contentHash);
    const storedHashes = row?.visionImageHashes ?? [];
    const visionStale = vision !== undefined && !sameStrings(imageHashes, storedHashes);

    if (textCached) {
      result.cached += 1;
      if (!visionStale) {
        if (vision !== undefined && images.length > 0) {
          visionCounts.cached += 1;
        }
        continue;
      }
    }

    // Text side: the cached answer, or up to two fresh attempts.
    let text: ProductAttributes | null;
    if (textCached) {
      text = textAttributesFromStored(row.textAttributes, product);
    } else {
      text = null;
      for (let attempt = 0; attempt < 2 && text === null; attempt += 1) {
        try {
          text = parseEnrichment(
            await llm.completeStructured({
              prompt: buildEnrichmentPrompt(product),
              schema: ENRICHMENT_SCHEMA,
              operation: "enrichment",
              storeId: shopDomain,
            }),
            product,
          );
        } catch {
          // A per-call failure (unparseable response, transient API error) is
          // treated like invalid output: retry once, then mark failed.
          text = null;
        }
      }
      result[text === null ? "failed" : "enriched"] += 1;
    }

    // Vision side: the stored answer, or a fresh analysis when the images
    // changed (or vanished).
    let visionAnswer: VisionAttributes | null = visionAttributesFromStored(
      row?.visionAttributes,
    );
    let visionStatus = row?.visionStatus ?? "none";
    let visionHashes = storedHashes;
    if (visionStale) {
      if (images.length === 0) {
        visionAnswer = null;
        visionStatus = "none";
        visionHashes = [];
      } else {
        const inline = await fetchInlineImages(fetchImage, images);
        if (inline.length === 0) {
          // Nothing to show the model: no call, no key update — retried next run.
          visionAnswer = null;
          visionStatus = "failed";
          visionCounts.failed += 1;
        } else {
          visionAnswer = null;
          for (let attempt = 0; attempt < 2 && visionAnswer === null; attempt += 1) {
            try {
              visionAnswer = parseVisionAttributes(
                await vision!.llm.completeStructured({
                  prompt: buildVisionPrompt(product),
                  schema: VISION_SCHEMA,
                  operation: "vision",
                  temperature: 0,
                  storeId: shopDomain,
                  images: inline,
                }),
              );
            } catch {
              visionAnswer = null;
            }
          }
          visionStatus = visionAnswer === null ? "failed" : "enriched";
          visionHashes = imageHashes;
          visionCounts.analysed += 1;
          if (visionAnswer === null) {
            visionCounts.failed += 1;
          }
        }
      }
    } else if (vision !== undefined && images.length > 0) {
      visionCounts.cached += 1;
    }

    const merged = mergeAttributes(text, visionAnswer);
    const data =
      merged === null
        ? {
            status: "failed",
            category: null,
            colors: [],
            primaryColor: null,
            occasions: [],
            fit: null,
            styleTags: [],
            seasons: [],
            sleeveLength: null,
            neckline: null,
            garmentLength: null,
            pattern: null,
            materialAppearance: null,
          }
        : { status: "enriched", ...merged };
    const sources = {
      textAttributes: jsonColumn(text),
      visionAttributes: jsonColumn(visionAnswer),
      visionImageHashes: visionHashes,
      visionStatus,
    };
    await db.productEnrichment.upsert({
      where: {
        shopDomain_productId: { shopDomain, productId: product.productId },
      },
      create: {
        shopDomain,
        productId: product.productId,
        contentHash: product.contentHash,
        enrichmentVersion: ENRICHMENT_VERSION,
        ...data,
        ...sources,
      },
      update: {
        contentHash: product.contentHash,
        enrichmentVersion: ENRICHMENT_VERSION,
        ...data,
        ...sources,
      },
    });
  }

  if (vision !== undefined) {
    const cost = await db.aiCall.aggregate({
      _sum: { costUsd: true },
      where: { shopDomain, operation: "vision", createdAt: { gte: startedAt } },
    });
    visionCounts.costUsd = cost._sum.costUsd ?? 0;
    result.vision = visionCounts;
  }
  return result;
}

/** The `vision: …` operator report line (YOY-121 AC-6), one format for every ingest path. */
export function formatVisionReport(vision: VisionResult): string {
  return `vision: analysed ${vision.analysed}, cached ${vision.cached}, failed ${vision.failed}, cost $${vision.costUsd.toFixed(6)}`;
}

/**
 * LLM port wired for enrichment: the configured classification/enrichment
 * model (AC-1) metered through the Prisma cost ledger. Requires
 * GEMINI_API_KEY — construct only outside the default offline test run.
 */
export function createEnrichmentLlmClient(db: PrismaClient): LlmClient {
  return createGeminiLlmClient({
    modelId: geminiModelsFromEnv().classificationModel,
    costRecorder: createPrismaCostRecorder(db),
  });
}

/**
 * LLM port wired for the vision pass (YOY-121 AC-2): `GEMINI_VISION_MODEL`
 * (default the docs/VISION-MODEL.md choice) at an explicit thinking level
 * (`GEMINI_VISION_THINKING_LEVEL`, default `low` — never the model default,
 * per the binding comment), metered through the Prisma cost ledger under
 * operation "vision". Requires GEMINI_API_KEY.
 */
export function createVisionLlmClient(db: PrismaClient): LlmClient {
  const models = geminiModelsFromEnv();
  return createGeminiLlmClient({
    modelId: models.visionModel,
    thinkingLevel: models.visionThinkingLevel,
    costRecorder: createPrismaCostRecorder(db),
  });
}
