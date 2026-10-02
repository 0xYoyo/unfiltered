import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_JUDGE_ROW_CHARS,
  orderByVerdict,
  type Judge,
  type JudgeCandidate,
  type JudgeCandidateOption,
  type JudgeLabel,
  type JudgeVerdictCode,
} from "@unfiltered/engine";

/**
 * Engine v2's judge step (YOY-147): the page's products, read as compact
 * rows, judged in one call under a deadline. Whatever goes wrong — the
 * deadline, a failed call, an answer invalid twice — the page is served in
 * find order and no error reaches the shopper (AC-6, AC-7).
 */

/** Env var naming the judge deadline in milliseconds (AC-6). */
export const JUDGE_DEADLINE_MS_ENV = "JUDGE_DEADLINE_MS";
/** How long the judge may take after its call started (AC-6). */
export const DEFAULT_JUDGE_DEADLINE_MS = 1_500;
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

/** The row length from `JUDGE_ROW_CHARS`; unset means 320. A malformed value fails at construction. */
export function judgeRowCharsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntFromEnv(env, JUDGE_ROW_CHARS_ENV, DEFAULT_JUDGE_ROW_CHARS);
}

/** How the judge step ended: the routeReason it gives the response (AC-11). */
export type JudgeOutcome = "judged" | "judge-timeout" | "judge-error";

/**
 * Read the page's products as judge candidates, in the given order (AC-2):
 * the catalog row's title, price and description, every option name with
 * the values its variants offer (merchant order, each value once), and the
 * written card's summary — null when the product has no written card.
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
  const [products, variants, cards] = await Promise.all([
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
      select: { productId: true, summary: true },
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
  const summaryOf = new Map(
    cards
      .filter((card) => card.summary.trim() !== "")
      .map((card) => [card.productId, card.summary]),
  );
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
        summary: summaryOf.get(productId) ?? null,
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
   * Whether the paid judge call started (AC-11). False only when the
   * page's rows could not be read, before any call.
   */
  started: boolean;
  /** The page in verdict order when judged; otherwise in find order. */
  items: JudgeStepItem<T>[];
}

export interface JudgeStepRequest<T extends { productId: string }> {
  judge: Judge;
  db: PrismaClient;
  shopDomain: string;
  sentence: string;
  /** The page's judged part, in find order. */
  items: readonly T[];
  searchId: string;
  deadlineMs: number;
}

/**
 * Judge one page (AC-2 – AC-8). The deadline starts with the call: when it
 * passes first, the call is aborted and the page is served in find order
 * (AC-6). A failed call or an answer invalid twice serves find order too
 * (AC-4, AC-7). Never rejects.
 */
export async function runJudgeStep<T extends { productId: string }>(
  request: JudgeStepRequest<T>,
): Promise<JudgeStepResult<T>> {
  const { judge, db, shopDomain, sentence, items, searchId, deadlineMs } = request;
  const findOrder = (outcome: JudgeOutcome, started = true): JudgeStepResult<T> => ({
    outcome,
    started,
    items: items.map((item) => ({ item, verdict: null, label: null })),
  });
  let candidates: JudgeCandidate[];
  try {
    candidates = await loadJudgeCandidates(
      db,
      shopDomain,
      items.map((item) => item.productId),
    );
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

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, deadlineMs);
  });
  // The call's failure is a value, so a rejection after the deadline won is
  // never unobserved.
  const call = judge
    .judge({ sentence, candidates, storeId: shopDomain, searchId, signal: controller.signal })
    .then(
      (verdicts) => ({ kind: "answered" as const, verdicts }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  const settled = await Promise.race([call, deadline]);
  clearTimeout(timer);

  if (settled.kind === "timeout") {
    warnJudgeFailure(searchId, "judge-timeout", new Error(`no answer within ${deadlineMs}ms`));
    return findOrder("judge-timeout");
  }
  if (settled.kind === "failed") {
    warnJudgeFailure(searchId, "judge-error", settled.error);
    return findOrder("judge-error");
  }
  return {
    outcome: "judged",
    started: true,
    items: orderByVerdict(items, settled.verdicts),
  };
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
