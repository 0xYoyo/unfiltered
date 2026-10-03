import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_JUDGE_ROW_CHARS,
  JUDGE_LABEL_TEMPLATES,
  JUDGE_MISSED_WISHES,
  JUDGE_PROMPT_VERSION,
  JUDGE_VERDICTS,
  orderByVerdict,
  VISION_NOT_APPLICABLE,
  type Judge,
  type JudgeAnswer,
  type JudgeCandidate,
  type JudgeCandidateAttribute,
  type JudgeCandidateOption,
  type JudgeLabel,
  type JudgeVerdict,
  type JudgeVerdictCode,
} from "@unfiltered/engine";

import { normalizeReuseQuery } from "./events.server";

/**
 * Engine v2's judge step (YOY-147): the page's products, read as compact
 * rows, judged in one call under a deadline. Whatever goes wrong — the
 * deadline, a failed call, an answer invalid twice — the page is served in
 * find order and no error reaches the shopper (AC-6, AC-7).
 *
 * YOY-148: an answer is stored under a cache key and a repeat of the same
 * page is served from it with no call (`judge-cached`); every judged or
 * cache-served page writes one verdict row per product; and a call past
 * the deadline is not aborted — it runs on to the give-up time, its answer
 * is cached, and its labels are handed to the labels endpoint.
 */

/** Env var naming the judge deadline in milliseconds (AC-6). */
export const JUDGE_DEADLINE_MS_ENV = "JUDGE_DEADLINE_MS";
/** How long the judge may take after its call started (AC-6). */
export const DEFAULT_JUDGE_DEADLINE_MS = 1_500;
/** Env var naming how long a call past its deadline may run on (YOY-148 AC-6). */
export const JUDGE_GIVE_UP_MS_ENV = "JUDGE_GIVE_UP_MS";
/** When a judge call is given up, counted from its start (YOY-148 AC-6). */
export const DEFAULT_JUDGE_GIVE_UP_MS = 6_000;
/** Env var naming the characters a candidate row is cut to (AC-2). */
export const JUDGE_ROW_CHARS_ENV = "JUDGE_ROW_CHARS";

function positiveIntFromEnv(
  env: Record<string, string | undefined>,
  variable: string,
  fallback: number,
): number {
  const raw = env[variable];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${variable} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The deadline from `JUDGE_DEADLINE_MS`; unset means 1,500. A malformed value fails at construction. */
export function judgeDeadlineMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntFromEnv(env, JUDGE_DEADLINE_MS_ENV, DEFAULT_JUDGE_DEADLINE_MS);
}

/** The give-up time from `JUDGE_GIVE_UP_MS`; unset means 6,000. A malformed value fails at construction. */
export function judgeGiveUpMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntFromEnv(env, JUDGE_GIVE_UP_MS_ENV, DEFAULT_JUDGE_GIVE_UP_MS);
}

/** The row length from `JUDGE_ROW_CHARS`; unset means 480. A malformed value fails at construction. */
export function judgeRowCharsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntFromEnv(env, JUDGE_ROW_CHARS_ENV, DEFAULT_JUDGE_ROW_CHARS);
}

/** How the judge step ended: the routeReason it gives the response (AC-11). */
export type JudgeOutcome = "judged" | "judge-timeout" | "judge-error" | "judge-cached";

/** The vision attributes a row carries, in row order, by their row names (AC-17). */
const JUDGE_VISION_ATTRIBUTES = [
  ["sleeve length", "sleeveLength"],
  ["neckline", "neckline"],
  ["garment length", "garmentLength"],
  ["pattern", "pattern"],
  ["material appearance", "materialAppearance"],
] as const;

type VisionColumns = Record<(typeof JUDGE_VISION_ATTRIBUTES)[number][1], string | null>;

/** The vision attributes that hold a value; not-applicable and unknown are left out. */
function visionAttributes(enrichment: VisionColumns | undefined): JudgeCandidateAttribute[] {
  if (enrichment === undefined) {
    return [];
  }
  return JUDGE_VISION_ATTRIBUTES.flatMap(([name, column]) => {
    const value = enrichment[column]?.trim() ?? "";
    return value === "" || value === VISION_NOT_APPLICABLE ? [] : [{ name, value }];
  });
}

/**
 * Read the page's products as judge candidates, in the given order (AC-2,
 * AC-17): the catalog row's title, price and description, every option name
 * with the values its variants offer (merchant order, each value once), the
 * written card's `facts` — null when the product has no written card — and
 * the enrichment's five vision attributes where present.
 */
export async function loadJudgeCandidates(
  db: PrismaClient,
  shopDomain: string,
  productIds: readonly string[],
): Promise<JudgeCandidate[]> {
  if (productIds.length === 0) {
    return [];
  }
  const ids = [...productIds];
  const [products, variants, cards, enrichments] = await Promise.all([
    db.catalogProduct.findMany({
      where: { shopDomain, productId: { in: ids } },
      select: {
        productId: true,
        title: true,
        description: true,
        priceMin: true,
        priceMax: true,
        currencyCode: true,
      },
    }),
    db.productVariant.findMany({
      where: { shopDomain, productId: { in: ids } },
      select: { productId: true, options: true },
      orderBy: [{ productId: "asc" }, { position: "asc" }],
    }),
    db.productCard.findMany({
      where: { shopDomain, productId: { in: ids }, status: "written" },
      select: { productId: true, facts: true },
    }),
    db.productEnrichment.findMany({
      where: { shopDomain, productId: { in: ids } },
      select: {
        productId: true,
        sleeveLength: true,
        neckline: true,
        garmentLength: true,
        pattern: true,
        materialAppearance: true,
      },
    }),
  ]);
  const optionsOf = new Map<string, JudgeCandidateOption[]>();
  for (const variant of variants) {
    const options = optionsOf.get(variant.productId) ?? [];
    optionsOf.set(variant.productId, options);
    if (!Array.isArray(variant.options)) {
      continue;
    }
    for (const raw of variant.options) {
      const { name, value } = (raw ?? {}) as { name?: unknown; value?: unknown };
      if (typeof name !== "string" || typeof value !== "string" || value.trim() === "") {
        continue;
      }
      let option = options.find((entry) => entry.name === name);
      if (option === undefined) {
        option = { name, values: [] };
        options.push(option);
      }
      if (!option.values.includes(value)) {
        option.values.push(value);
      }
    }
  }
  const factsOf = new Map(
    cards
      .filter((card) => card.facts.trim() !== "")
      .map((card) => [card.productId, card.facts]),
  );
  const enrichmentOf = new Map(enrichments.map((row) => [row.productId, row]));
  const byId = new Map(products.map((product) => [product.productId, product]));
  return ids.flatMap((productId) => {
    const product = byId.get(productId);
    if (product === undefined) {
      return [];
    }
    return [
      {
        id: productId,
        title: product.title,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        currencyCode: product.currencyCode,
        options: optionsOf.get(productId) ?? [],
        facts: factsOf.get(productId) ?? null,
        attributes: visionAttributes(enrichmentOf.get(productId)),
        description: product.description,
      },
    ];
  });
}

/** One page item after the judge step. */
export interface JudgeStepItem<T> {
  item: T;
  /** Null when the judge did not answer for the page. */
  verdict: JudgeVerdictCode | null;
  label: JudgeLabel | null;
}

export interface JudgeStepResult<T> {
  outcome: JudgeOutcome;
  /**
   * Whether the paid judge call started (AC-11). False when the page's rows
   * could not be read, before any call, and when the cache answered.
   */
  started: boolean;
  /**
   * True when the deadline passed while the call runs on (YOY-148 AC-7):
   * its labels arrive through the labels endpoint.
   */
  labelsPending: boolean;
  /** The page in verdict order when judged or cached; otherwise in find order. */
  items: JudgeStepItem<T>[];
  /**
   * The judge's second reading of the sentence (YOY-150 AC-7) when it
   * answered in time or from the cache; null otherwise.
   */
  otherReading: string | null;
}

export interface JudgeStepRequest<T extends { productId: string }> {
  judge: Judge;
  db: PrismaClient;
  shopDomain: string;
  sentence: string;
  /** The chain the sentence follows (YOY-150 AC-2); absent on a fresh search. */
  previousSentence?: string;
  /** The page's judged part, in find order. */
  items: readonly T[];
  searchId: string;
  deadlineMs: number;
  /**
   * When the call is given up, counted from its start (YOY-148 AC-6);
   * never earlier than the deadline. 6,000 ms by default.
   */
  giveUpMs?: number;
  /** The page served (YOY-148 AC-4); 1 by default. */
  page?: number;
  /** The whole-order position of the page's first item (YOY-148 AC-4); 0 by default. */
  positionOffset?: number;
  /**
   * Whether the judge's `excluded` flags drop products (YOY-149 AC-11);
   * true by default. False when the shopper removed an `exclude` chip
   * (AC-15): the sentence still says "not black", so the flags — fresh or
   * cached — are ignored for the request.
   */
  applyExcluded?: boolean;
}

/**
 * The answer-cache key (YOY-148 AC-1): the SHA-256 of the normalized search
 * text, the candidate ids in order, each candidate's card text hash (empty
 * for a product with no written card), the judge's provider and model, and
 * the prompt version. Price and stock are not in it (AC-3). A refinement's
 * previous chain (YOY-150 AC-2) is part of it: the same words after another
 * search are another question.
 */
export function judgeCacheKey(input: {
  sentence: string;
  previousSentence?: string;
  candidates: ReadonlyArray<{ id: string; cardTextHash: string }>;
  identity: string;
  promptVersion?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeReuseQuery(input.sentence),
        ...(input.previousSentence !== undefined && input.previousSentence.trim() !== ""
          ? [input.previousSentence.split("\n").map(normalizeReuseQuery)]
          : []),
        input.candidates.map((candidate) => [candidate.id, candidate.cardTextHash]),
        input.identity,
        input.promptVersion ?? JUDGE_PROMPT_VERSION,
      ]),
    )
    .digest("hex");
}

/** The written cards' text hashes for the page's products; "" where there is none. */
async function cardTextHashes(
  db: PrismaClient,
  shopDomain: string,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  const cards = await db.productCard.findMany({
    where: { shopDomain, productId: { in: [...productIds] }, status: "written" },
    select: { productId: true, cardTextHash: true },
  });
  return new Map(cards.map((card) => [card.productId, card.cardTextHash]));
}

const VERDICT_SET: ReadonlySet<string> = new Set(JUDGE_VERDICTS);
const MISSED_SET: ReadonlySet<string> = new Set(JUDGE_MISSED_WISHES);
const TEMPLATE_SET: ReadonlySet<string> = new Set(JUDGE_LABEL_TEMPLATES);

/**
 * A stored answer read back, or null when it no longer fits: one well-formed
 * verdict per candidate, in candidate order, and the second reading
 * (YOY-150 AC-7). A row that fails is a miss. A row written before the
 * reading existed is a bare verdict array and reads as no reading.
 */
function storedAnswer(
  stored: Prisma.JsonValue,
  candidates: readonly JudgeCandidate[],
): JudgeAnswer | null {
  let value: Prisma.JsonValue = stored;
  let otherReading: string | null = null;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    const reading = stored.otherReading;
    if (!(reading === null || typeof reading === "string")) {
      return null;
    }
    otherReading = reading;
    value = stored.verdicts ?? null;
  }
  if (!Array.isArray(value) || value.length !== candidates.length) {
    return null;
  }
  const verdicts: JudgeVerdict[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const { id, verdict, missed, label, excluded } = raw as Record<string, unknown>;
    if (
      id !== candidates[index]!.id ||
      typeof verdict !== "string" ||
      !VERDICT_SET.has(verdict) ||
      !Array.isArray(missed) ||
      !missed.every((flag) => typeof flag === "string" && MISSED_SET.has(flag))
    ) {
      return null;
    }
    let parsedLabel: JudgeLabel | null = null;
    if (label !== null) {
      const { template, values } = (label ?? {}) as Record<string, unknown>;
      if (
        typeof template !== "string" ||
        !TEMPLATE_SET.has(template) ||
        !Array.isArray(values) ||
        !values.every((entry) => typeof entry === "string")
      ) {
        return null;
      }
      parsedLabel = { template, values } as JudgeLabel;
    }
    verdicts.push({
      id,
      verdict: verdict as JudgeVerdictCode,
      missed: missed as JudgeVerdict["missed"],
      label: parsedLabel,
      excluded: excluded === true,
    });
  }
  return { verdicts, otherReading };
}

async function readCachedAnswer(
  db: PrismaClient,
  shopDomain: string,
  cacheKey: string,
  candidates: readonly JudgeCandidate[],
): Promise<JudgeAnswer | null> {
  try {
    const row = await db.judgeAnswer.findUnique({
      where: { shopDomain_cacheKey: { shopDomain, cacheKey } },
      select: { verdicts: true },
    });
    return row === null ? null : storedAnswer(row.verdicts, candidates);
  } catch (error) {
    warnJudgeStore("cache read", error);
    return null;
  }
}

/** Store an answer (AC-1, AC-6). Never throws: the cache is an optimisation. */
async function storeAnswer(
  db: PrismaClient,
  shopDomain: string,
  cacheKey: string,
  answer: JudgeAnswer,
): Promise<void> {
  const value = {
    verdicts: answer.verdicts.map((entry) => ({
      id: entry.id,
      verdict: entry.verdict,
      missed: [...entry.missed],
      label:
        entry.label === null
          ? null
          : { template: entry.label.template, values: [...entry.label.values] },
      excluded: entry.excluded,
    })),
    otherReading: answer.otherReading,
  } as Prisma.InputJsonValue;
  try {
    await db.judgeAnswer.upsert({
      where: { shopDomain_cacheKey: { shopDomain, cacheKey } },
      create: { shopDomain, cacheKey, verdicts: value },
      update: { verdicts: value },
    });
  } catch (error) {
    warnJudgeStore("cache write", error);
  }
}

/**
 * One verdict row per product of a judged or cache-served page (AC-4), at
 * its whole-order position as served. Never throws: the log is an observer.
 */
async function writeVerdictRows<T extends { productId: string }>(
  db: PrismaClient,
  input: {
    shopDomain: string;
    searchId: string;
    page: number;
    positionOffset: number;
    served: ReadonlyArray<{ item: T; verdict: JudgeVerdictCode; label: JudgeLabel | null }>;
    verdicts: readonly JudgeVerdict[];
    cached: boolean;
  },
): Promise<void> {
  const missedOf = new Map(input.verdicts.map((entry) => [entry.id, entry.missed]));
  try {
    await db.judgeVerdict.createMany({
      data: input.served.map((entry, index) => ({
        searchId: input.searchId,
        shopDomain: input.shopDomain,
        productId: entry.item.productId,
        page: input.page,
        position: input.positionOffset + index,
        verdict: entry.verdict,
        missed: [...(missedOf.get(entry.item.productId) ?? [])],
        labelTemplate: entry.label?.template ?? null,
        cached: input.cached,
      })),
    });
  } catch (error) {
    warnJudgeStore("verdict log write", error);
  }
}

/** The labels a late answer delivers (AC-8): one per product id, null for none. */
export type PendingLabels = Record<string, JudgeLabel | null>;

interface PendingEntry {
  shopDomain: string;
  labels: Promise<PendingLabels>;
}

/**
 * Late answers in flight and just settled, by search and page (AC-8). A
 * settled entry stays readable for `SETTLED_LABELS_TTL_MS`, then is dropped;
 * the labels endpoint answers an empty set for anything it no longer holds.
 */
const pendingLabels = new Map<string, PendingEntry>();
const SETTLED_LABELS_TTL_MS = 60_000;

function pendingKey(searchId: string, page: number): string {
  return `${searchId}\u0000${page}`;
}

/**
 * The labels of a page served on a deadline miss (AC-8, AC-9): held until
 * the judge answers or gives up, then one label per product id — or an
 * empty set when it gave up, failed, or nothing is pending for this shop's
 * search and page. Never an order.
 */
export async function awaitPendingLabels(
  shopDomain: string,
  searchId: string,
  page: number,
): Promise<PendingLabels> {
  const entry = pendingLabels.get(pendingKey(searchId, page));
  if (entry === undefined || entry.shopDomain !== shopDomain) {
    return {};
  }
  return entry.labels;
}

/** Test seam: forget every pending and settled late answer. */
export function resetPendingLabels(): void {
  pendingLabels.clear();
}

/**
 * Judge one page (AC-2 – AC-8 of YOY-147; YOY-148). A stored answer serves
 * the page with no call. Otherwise the deadline starts with the call: when
 * it passes first, the page is served in find order with labels pending,
 * and the call runs on until it answers or the give-up time aborts it
 * (YOY-148 AC-6). A failed call or an answer invalid twice serves find
 * order (AC-4, AC-7). Never rejects.
 */
export async function runJudgeStep<T extends { productId: string }>(
  request: JudgeStepRequest<T>,
): Promise<JudgeStepResult<T>> {
  const { judge, db, shopDomain, sentence, previousSentence, items, searchId, deadlineMs } =
    request;
  const giveUpMs = Math.max(request.giveUpMs ?? DEFAULT_JUDGE_GIVE_UP_MS, deadlineMs);
  const page = request.page ?? 1;
  const positionOffset = request.positionOffset ?? 0;
  const applyExcluded = request.applyExcluded ?? true;
  const order = (verdicts: readonly JudgeVerdict[]) =>
    orderByVerdict(
      items,
      applyExcluded ? verdicts : verdicts.map((entry) => ({ ...entry, excluded: false })),
    );
  const findOrder = (
    outcome: JudgeOutcome,
    started = true,
    labelsPending = false,
  ): JudgeStepResult<T> => ({
    outcome,
    started,
    labelsPending,
    items: items.map((item) => ({ item, verdict: null, label: null })),
    otherReading: null,
  });
  let candidates: JudgeCandidate[];
  let cacheKey: string;
  try {
    const productIds = items.map((item) => item.productId);
    const [loaded, hashes] = await Promise.all([
      loadJudgeCandidates(db, shopDomain, productIds),
      cardTextHashes(db, shopDomain, productIds),
    ]);
    candidates = loaded;
    cacheKey = judgeCacheKey({
      sentence,
      ...(previousSentence !== undefined ? { previousSentence } : {}),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        cardTextHash: hashes.get(candidate.id) ?? "",
      })),
      identity: judge.identity ?? "unknown",
    });
  } catch (error) {
    warnJudgeFailure(searchId, "judge-error", error);
    return findOrder("judge-error", false);
  }
  // A product whose row vanished since hydration is judged as missing:
  // the answer must cover every candidate the page shows.
  if (candidates.length !== items.length) {
    warnJudgeFailure(searchId, "judge-error", new Error("judge rows do not cover the page"));
    return findOrder("judge-error", false);
  }

  const serve = async (
    answer: JudgeAnswer,
    outcome: "judged" | "judge-cached",
  ): Promise<JudgeStepResult<T>> => {
    const { verdicts } = answer;
    const served = order(verdicts);
    await writeVerdictRows(db, {
      shopDomain,
      searchId,
      page,
      positionOffset,
      served,
      verdicts,
      cached: outcome === "judge-cached",
    });
    return {
      outcome,
      started: outcome === "judged",
      labelsPending: false,
      items: served,
      otherReading: answer.otherReading,
    };
  };

  const cached = await readCachedAnswer(db, shopDomain, cacheKey, candidates);
  if (cached !== null) {
    return serve(cached, "judge-cached");
  }

  // The call runs to the give-up time; the deadline only decides whether
  // this response waits for it (YOY-148 AC-6).
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), giveUpMs);
  // The call's failure is a value, so a rejection after the deadline won is
  // never unobserved.
  const call = judge
    .judge({
      sentence,
      ...(previousSentence !== undefined ? { previousSentence } : {}),
      candidates,
      storeId: shopDomain,
      searchId,
      signal: controller.signal,
    })
    .then(
      (answer) => ({ kind: "answered" as const, answer }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    )
    .then(async (settled) => {
      clearTimeout(giveUp);
      if (settled.kind === "answered") {
        await storeAnswer(db, shopDomain, cacheKey, settled.answer);
      }
      return settled;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), deadlineMs);
  });
  const settled = await Promise.race([call, deadline]);
  clearTimeout(timer);

  if (settled.kind === "timeout") {
    warnJudgeFailure(searchId, "judge-timeout", new Error(`no answer within ${deadlineMs}ms`));
    const key = pendingKey(searchId, page);
    const labels = call.then((late): PendingLabels => {
      if (late.kind === "failed") {
        warnJudgeFailure(searchId, "judge-timeout", late.error);
        return {};
      }
      return Object.fromEntries(
        order(late.answer.verdicts).map((entry) => [entry.item.productId, entry.label]),
      );
    });
    pendingLabels.set(key, { shopDomain, labels });
    void labels.then(() => {
      setTimeout(() => {
        if (pendingLabels.get(key)?.labels === labels) {
          pendingLabels.delete(key);
        }
      }, SETTLED_LABELS_TTL_MS).unref?.();
    });
    return findOrder("judge-timeout", true, true);
  }
  if (settled.kind === "failed") {
    warnJudgeFailure(searchId, "judge-error", settled.error);
    return findOrder("judge-error");
  }
  return serve(settled.answer, "judged");
}

function warnJudgeFailure(searchId: string, outcome: JudgeOutcome, error: unknown): void {
  console.warn(
    "[search] judge step fell back to find order",
    JSON.stringify({
      searchId,
      outcome,
      error: error instanceof Error ? error.name : String(error),
    }),
  );
}

function warnJudgeStore(what: string, error: unknown): void {
  console.warn(
    `[search] judge ${what} failed`,
    JSON.stringify({ error: error instanceof Error ? error.name : String(error) }),
  );
}
