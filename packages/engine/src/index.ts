/**
 * Public API of the unfiltered search engine.
 *
 * Catalog-agnostic by contract: inputs and outputs speak only in generic
 * documents, fields, and scores — no commerce-platform concepts. Each
 * consumer is responsible for mapping its own catalog into and out of these
 * types.
 */

/** Semantic version of the engine's public API contract. */
export const version = "0.4.0";

/**
 * The URL this module was actually loaded from. Test runs alias
 * @unfiltered/engine to this TypeScript source (root vitest.config.ts); a
 * URL under compiled dist/ output means the alias was bypassed and the run
 * is scoring whatever was last built, not the current source. Generic by
 * construction: any dist skew — missing symbol or not — moves this URL.
 */
export const ENGINE_SOURCE_URL = import.meta.url;

export {
  type ClassicSearchHit,
  type ClassicSearchRequest,
  type ClassicSearchResult,
  type ClassicSearchStore,
} from "./classic.js";

export {
  CLASSIFICATION_SCHEMA,
  classifyByHeuristics,
  createQueryClassifier,
  normalizeQuery,
  type ClassificationContext,
  type ClassificationDecision,
  type ClassificationReason,
  type QueryClassifier,
  type QueryClassifierOptions,
  type QueryRoute,
} from "./classify.js";
export {
  CLASSIFIER_COLOR_WORDS,
  COLORWAY_COLORS,
  COLORWAY_MODIFIERS,
  COLORWAY_WORDS,
  isColorwayDesignator,
} from "./colors.js";

export {
  carryOverRefinementConstraints,
  createIntentExtractor,
  enforceComparativeBounds,
  INTENT_SCHEMA,
  IntentExtractionError,
  mergeRefinementIntent,
  parseIntent,
  parseRefinementAnswer,
  REFINEMENT_INTENT_SCHEMA,
  REFINEMENT_OUTCOMES,
  type Intent,
  type IntentEscalation,
  type IntentExtraction,
  type IntentExtractionContext,
  type IntentExtractor,
  type IntentExtractorOptions,
  type IntentTier,
  type RefinementAnswer,
  type RefinementOutcome,
} from "./intent.js";

export {
  createEscalatingIntentExtractor,
  DEFAULT_INTENT_ESCALATION_THRESHOLD,
  DEFAULT_INTENT_HEDGE_AFTER_MS,
  INTENT_ESCALATION_CLASSES,
  matchIntentEscalationClass,
  type EscalatingIntentExtractorOptions,
  type IntentEscalationClass,
} from "./intent-escalation.js";

export {
  buildJudgePrompt,
  createDecisionJudge,
  createJudge,
  createLlmJudge,
  DECISION_JUDGE_QUESTIONS,
  DEFAULT_JUDGE_PROVIDER,
  DEFAULT_JUDGE_ROW_CHARS,
  JUDGE_ANSWER_CODES,
  JUDGE_DESCRIPTION_CHARS,
  JUDGE_LABEL_CODES,
  JUDGE_LABEL_MAX_WORDS,
  JUDGE_LABEL_TEMPLATES,
  JUDGE_MISSED_CODES,
  JUDGE_MISSED_WISHES,
  JUDGE_PROVIDER_ENV,
  JUDGE_PROVIDERS,
  JUDGE_SCHEMA,
  JUDGE_VERDICT_CODES,
  JUDGE_VERDICTS,
  JudgeAnswerError,
  judgeProviderFromEnv,
  judgeRow,
  JUDGE_PROMPT_VERSION,
  JUDGE_READING_MAX_WORDS,
  orderByVerdict,
  parseJudgeAnswer,
  type DecisionJudgeOptions,
  type Judge,
  type JudgeAnswer,
  type JudgeCandidate,
  type JudgeCandidateAttribute,
  type JudgeCandidateOption,
  type JudgedItem,
  type JudgeFactoryOptions,
  type JudgeLabel,
  type JudgeLabelTemplate,
  type JudgeMissedWish,
  type JudgeProvider,
  type JudgeRequest,
  type JudgeVerdict,
  type JudgeVerdictCode,
  type LlmJudgeOptions,
} from "./judge.js";
export {
  buildExtractPrompt,
  createWishExtractor,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SCHEMA,
  ExtractAnswerError,
  NO_WISHES,
  parseExtractAnswer,
  previousChainLine,
  sentenceHasNumber,
  sentenceHasText,
  sentenceHasToken,
  sentenceNegates,
  statedCurrency,
  wishesText,
  type ExcludedTerm,
  type ExtractedWishes,
  type ExtractRequest,
  type StatedPrice,
  type WishExtractor,
} from "./extract.js";

export {
  ATTRIBUTE_EVIDENCE_TERMS,
  attributeEvidenceTerms,
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
  CATEGORY_GROUPS,
  CATEGORY_LIKE_ATTRIBUTES,
  expandCategoryConstraint,
  normalizeAttributeWord,
  normalizeCategory,
  normalizeCategoryLikeAttribute,
  normalizeOccasion,
  normalizeVisionValue,
  VISION_GARMENT_LENGTHS,
  VISION_MATERIAL_APPEARANCES,
  VISION_NECKLINES,
  VISION_NOT_APPLICABLE,
  VISION_PATTERNS,
  VISION_SLEEVE_LENGTHS,
  type CanonicalCategory,
  type CanonicalOccasion,
  type CategoryLikeAttribute,
  type VisionGarmentLength,
  type VisionMaterialAppearance,
  type VisionNeckline,
  type VisionPattern,
  type VisionSleeveLength,
} from "./taxonomy.js";

export {
  appliedConstraints,
  composeQueryText,
  constraintsFromIntent,
  createRetriever,
  EmptyQueryTextError,
  type AppliedConstraint,
  type RetrievalConstraints,
  type RetrievalHit,
  type RetrievalRequest,
  type RetrievalResult,
  type RetrievalTimings,
  type Retriever,
  type RetrieverOptions,
  type RetrievalStore,
  type StoreQueryHit,
  type StoreQueryRequest,
} from "./retrieve.js";

/** A single searchable document, as the consumer indexed it. */
export interface EngineDocument {
  /** Consumer-assigned stable identifier. */
  id: string;
  /** Arbitrary named text fields to search over. */
  fields: Record<string, string>;
}

/** Options controlling a single search call. */
export interface SearchOptions {
  /** Maximum number of hits to return. Defaults to the engine's own limit. */
  limit?: number;
  /** Number of hits to skip, for pagination. */
  offset?: number;
}

/** One scored hit in a search result. */
export interface SearchHit {
  /** Identifier of the matching document. */
  documentId: string;
  /** Relevance score; higher is more relevant. */
  score: number;
}

/** The outcome of a search call. */
export interface SearchResult {
  /** Scored hits, most relevant first. */
  hits: SearchHit[];
  /** Total number of matching documents before limit/offset. */
  totalCount: number;
  /** The query string the engine actually evaluated. */
  query: string;
}

/** A JSON Schema document describing the shape a model's output must satisfy. */
export type JsonSchema = Record<string, unknown>;

/** One structured-output completion request to an LLM. */
export interface StructuredCompletionRequest {
  /** Full prompt text for the model. */
  prompt: string;
  /** JSON Schema the model's JSON output must conform to. */
  schema: JsonSchema;
  /** Cost-ledger operation label, e.g. "classification", "intent", "enrichment". */
  operation: string;
  /**
   * Sampling temperature, when the call needs a specific one — routing
   * decisions pass 0 for determinism (YOY-52). Absent means the provider's
   * default.
   */
  temperature?: number;
  /** Store (tenant) the call is made on behalf of, for metering, when known — an opaque identifier; the Shopify adapter passes the myshopify domain. */
  storeId?: string;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
  /**
   * Caller's abort signal, when the call runs under a budget that spans
   * more than one call (the intent ladder's deadline, YOY-64 AC-3).
   * Implementations abort the request when it fires, on top of their own
   * per-request timeout.
   */
  signal?: AbortSignal;
  /**
   * Images the model must read alongside the prompt (YOY-120 AC-3; PRD
   * capability 14): raw bytes with their MIME type, in the order they
   * should precede the text. Vendor-free — an adapter encodes them in its
   * own wire form. Absent or empty means a text-only call, byte-for-byte
   * what it was before images existed.
   */
  images?: InlineImage[];
}

/** One image handed to the LLM port: bytes plus their MIME type. */
export interface InlineImage {
  /** e.g. "image/jpeg", "image/png", "image/webp". */
  mimeType: string;
  data: Uint8Array;
}

/**
 * Port for LLM structured-output completion. Implementations live outside the
 * engine (provider adapter packages); the engine and its consumers depend on
 * this vendor-free surface only.
 */
export interface LlmClient {
  /** Complete the prompt into schema-conforming JSON, parsed and returned. */
  completeStructured(request: StructuredCompletionRequest): Promise<unknown>;
}

/**
 * One typed question to a decision model (YOY-152 AC-2): `choice` picks one
 * of the criteria's keys, each described by its value; `yes-no` answers a
 * probability that the answer is yes.
 */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "yes-no"; instructions: string; criteria: { yes: string; no: string } };

/** One decision request: the text the questions are about, and the questions by key. */
export interface DecisionRequest {
  /** What the questions are asked about: plain text or a JSON object. */
  state: string | Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  /** Cost-ledger operation label, e.g. "judge". */
  operation: string;
  /** Store (tenant) the call is made on behalf of, for metering, when known. */
  storeId?: string;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
  /** Caller's abort signal; implementations abort the request when it fires. */
  signal?: AbortSignal;
}

/** A typed answer: the chosen key, or the probability of yes (0–1). */
export type DecisionAnswer = { type: "choice"; choice: string } | { type: "yes-no"; yes: number };

/**
 * Port for a decision model (YOY-152): typed answers to typed questions,
 * no free text. Implementations live outside the engine; the engine
 * depends on this vendor-free surface only.
 */
export interface DecisionClient {
  /** One answer per question key, as the model returned them. */
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}

/** One batch embedding request. */
export interface EmbeddingRequest {
  /** Texts to embed; one vector is returned per text, in order. */
  texts: string[];
  /** Cost-ledger operation label; implementations default to "embedding". */
  operation?: string;
  /** Store (tenant) the call is made on behalf of, for metering, when known — an opaque identifier; the Shopify adapter passes the myshopify domain. */
  storeId?: string;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
}

/**
 * Port for text embedding. Implementations declare the fixed dimension every
 * returned vector has.
 */
export interface EmbeddingClient {
  /** Dimension of every vector this client returns. */
  readonly dimension: number;
  /** Embed each text into a vector of exactly `dimension` numbers. */
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

/**
 * Usage of a single AI call, expressed provider-agnostically: adapters map
 * their vendor SDK's response into this shape before recording.
 */
export interface AiCallUsage {
  /** Provider name, e.g. "google". */
  provider: string;
  /** Provider model ID the call used. */
  modelId: string;
  /** What the call was for, e.g. "classification", "intent", "enrichment", "embedding". */
  operation: string;
  inputTokens: number;
  outputTokens: number;
  /** Store (tenant) the call was made on behalf of, when known. */
  storeId?: string;
  /** Correlation ID tying together every call serving one search. */
  searchId?: string;
}

/**
 * Port through which every AI call is metered. Provider adapters depend on
 * this interface only — never on the persistence behind it.
 */
export interface CostRecorder {
  record(usage: AiCallUsage): Promise<void>;
}

/** The engine's public interface. */
export interface Engine {
  /** API contract version this engine implements. */
  readonly version: string;
  /** Execute a search over the engine's index. */
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
}

/**
 * Create an engine instance.
 *
 * Stub implementation: no index, no matching — every search resolves to an
 * empty, well-typed result. Real search logic lands in later milestones.
 */
export function createEngine(): Engine {
  return {
    version,
    async search(query: string, _options?: SearchOptions): Promise<SearchResult> {
      return {
        hits: [],
        totalCount: 0,
        query,
      };
    },
  };
}
