import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@unfiltered/engine";

import { normalizeReuseQuery } from "../search/events.server";
import latencyProbeQueries from "../../scripts/latency-probe-queries.json";

/**
 * The score set builder (YOY-140 AC-1..AC-3): real shopper phrasing from the
 * playground's search log, topped up by Flash-Lite filler to a fixed shape —
 * six languages × 25 searches — then split 13 public / 12 hidden with a fixed
 * seed. The hidden half never enters the repository (NG-1): it is written
 * base64-encoded to a path outside it, or not at all.
 */

export const SCORE_LANGUAGES = ["en", "he", "ar", "ru", "fr", "es"] as const;
export type ScoreLanguage = (typeof SCORE_LANGUAGES)[number];

export const SEARCHES_PER_LANGUAGE = 25;
export const PUBLIC_PER_LANGUAGE = 13;
export const HIDDEN_PER_LANGUAGE = SEARCHES_PER_LANGUAGE - PUBLIC_PER_LANGUAGE;
/** Hebrew's size in the simple set (YOY-175 AC-1): 75, so its hidden half is 37, not 12. */
export const HEBREW_SEARCHES = 75;

/** A language's size in the simple set (YOY-175 AC-1): he 75, every other 25. */
export function searchesPerLanguage(language: ScoreLanguage): number {
  return language === "he" ? HEBREW_SEARCHES : SEARCHES_PER_LANGUAGE;
}

/** The public share of n searches (YOY-175 AC-1): ceil(n / 2) — 25 → 13, 75 → 38, 30 → 15. */
export function publicCount(n: number): number {
  return Math.ceil(n / 2);
}

/** The two score sets (YOY-175 AC-2): the current shape, and the hard searches. */
export const SCORE_SET_NAMES = ["simple", "hard"] as const;
export type ScoreSetName = (typeof SCORE_SET_NAMES)[number];

/** The five kinds of hard search (YOY-175 AC-2), in equal parts. */
export const HARD_KINDS = ["reference", "lookalike", "occasion", "vague", "two-wishes"] as const;
export type HardKind = (typeof HARD_KINDS)[number];
/** The hard set's languages and size (YOY-175 AC-2): en and he, 30 each. */
export const HARD_LANGUAGES = ["en", "he"] as const satisfies readonly ScoreLanguage[];
export const HARD_SEARCHES_PER_LANGUAGE = 30;
/** The split's fixed seed: the same entries always land in the same half. */
export const SCORE_SPLIT_SEED = 140;
/** The encoded hidden file must stay under this many bytes (AC-3). */
export const HIDDEN_MAX_BYTES = 48 * 1024;

/** Filler operation for the cost ledger and replay recordings. */
export const SCORE_FILLER_OPERATION = "score-filler";

export interface LogQuery {
  query: string;
  storeKey: string;
  date: Date;
}

export interface ScoreSetEntry {
  query: string;
  language: ScoreLanguage;
  source: "log" | "model";
  /** The language had no log entry: every one of its searches is model-written. */
  modelWritten: boolean;
  /**
   * The set the entry belongs to (YOY-175 AC-2). Every entry the builder
   * writes carries it; an entry without it — a set built before YOY-175 —
   * is a `simple` entry.
   */
  set?: ScoreSetName;
  /** A hard entry's kind (YOY-175 AC-2). */
  kind?: HardKind;
}

/** The set an entry belongs to: `simple` when it predates the field. */
export function setOf(entry: ScoreSetEntry): ScoreSetName {
  return entry.set ?? "simple";
}

/**
 * The language a logged search is filed under, by script class alone (AC-1):
 * any Hebrew letter → he, Arabic → ar, Cyrillic → ru, everything else → en.
 * fr and es are never assigned from the log — Latin script cannot tell them
 * from English reliably, so those two languages are model-written.
 */
export function detectLanguage(text: string): "en" | "he" | "ar" | "ru" {
  if (/\p{Script=Hebrew}/u.test(text)) return "he";
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  return "en";
}

/**
 * The first day of the playground era (YOY-141 AC-12): log searches before
 * it are M1-era test searches against a snowboard test catalog, not shopper
 * phrasing.
 */
export const LOG_SINCE = new Date(Date.UTC(2026, 7, 10));
/** A log search shorter than this after trimming is a keystroke, not a wish. */
export const LOG_MIN_LENGTH = 3;
/**
 * Zero-width format characters: the latency probe's invisible per-request
 * marker is built from U+200B, U+200C, U+200D and U+2060, so a log search
 * carrying any of them is a probe's, not a shopper's.
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/u;

const PROBE_QUERIES = new Set(
  Object.values(latencyProbeQueries as Record<string, string[]>)
    .flat()
    .map((query) => normalizeReuseQuery(query)),
);

/**
 * Whether a logged search is shopper-shaped (YOY-141 AC-12): submitted in
 * the playground era, at least three characters after trimming, no
 * zero-width format characters, and not one of the latency probe's
 * committed queries.
 */
export function isShopperShaped(entry: { query: string; date: Date }): boolean {
  return (
    entry.date.getTime() >= LOG_SINCE.getTime() &&
    entry.query.trim().length >= LOG_MIN_LENGTH &&
    !ZERO_WIDTH.test(entry.query) &&
    !PROBE_QUERIES.has(normalizeReuseQuery(entry.query))
  );
}

/**
 * Every shopper-shaped submitted search of the given store keys (AC-1,
 * YOY-141 AC-12): SearchEvent holds one row per submitted search and none
 * for previews. De-duplicated on the normalized text, keeping each query's
 * first occurrence, oldest first.
 */
export async function exportLogQueries(
  db: PrismaClient,
  storeKeys: readonly string[],
): Promise<LogQuery[]> {
  if (storeKeys.length === 0) {
    return [];
  }
  const rows = await db.searchEvent.findMany({
    where: { shopDomain: { in: [...storeKeys] }, createdAt: { gte: LOG_SINCE } },
    select: { query: true, shopDomain: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const seen = new Set<string>();
  const queries: LogQuery[] = [];
  for (const row of rows) {
    const key = normalizeReuseQuery(row.query);
    if (key === "" || seen.has(key)) continue;
    if (!isShopperShaped({ query: row.query, date: row.createdAt })) continue;
    seen.add(key);
    queries.push({ query: row.query.trim(), storeKey: row.shopDomain, date: row.createdAt });
  }
  return queries;
}

export type FillerShape = "short" | "medium" | "long";

/** How many filler searches of each shape make up `count` (AC-2): 60 / 30 / 10. */
export function fillerShapeCounts(count: number): Record<FillerShape, number> {
  const short = Math.round(count * 0.6);
  const long = Math.round(count * 0.1);
  return { short, medium: count - short - long, long };
}

const LANGUAGE_NAMES: Record<ScoreLanguage, string> = {
  en: "English",
  he: "Hebrew",
  ar: "Arabic",
  ru: "Russian",
  fr: "French",
  es: "Spanish",
};

const SHAPE_TEXT: Record<FillerShape, string> = {
  short: "one to three words, the way most people type into a shop's search box",
  medium: "four to eight words, naming the item plus one or two wishes (colour, use, price, fit)",
  long: "long or vague: a full sentence, a situation, or a loose wish rather than a product name",
};

const FILLER_SCHEMA = {
  type: "object",
  properties: {
    searches: { type: "array", items: { type: "string" } },
  },
  required: ["searches"],
};

/**
 * The filler prompt. Its last line is the request descriptor — the `Query:`
 * line replay recordings are keyed by — so one recording answers one
 * language-and-shape request.
 */
export function fillerPrompt(
  language: ScoreLanguage,
  shape: FillerShape,
  count: number,
  avoid: readonly string[],
): string {
  return [
    `Write ${count} different searches a shopper might type into an online clothing and accessories store, in ${LANGUAGE_NAMES[language]}.`,
    `Each search is ${SHAPE_TEXT[shape]}.`,
    "Write them as real shoppers do: lower case is fine, no numbering, no quotation marks.",
    ...(avoid.length > 0
      ? ["Do not repeat any of these:", ...avoid.map((query) => `- ${query}`)]
      : []),
    "Answer as JSON: {\"searches\": [ ... ]}.",
    `Query: filler ${language} ${shape} ${count}`,
  ].join("\n");
}

function fillShape(
  llm: LlmClient,
  language: ScoreLanguage,
  shape: FillerShape,
  count: number,
  taken: Set<string>,
  overflow: ((query: string) => boolean) | undefined,
): Promise<string[]> {
  return fillDistinct(
    llm,
    (needed, seen) => fillerPrompt(language, shape, needed, seen),
    `${language}/${shape}`,
    count,
    taken,
    overflow,
  );
}

/**
 * The filler check for repository-known searches (YOY-175 AC-1, amended): a
 * known filler search is pinned public while the added public share has
 * room; past it, the filler is written again, so the hidden half stays
 * drawn only from searches in no tracked file.
 */
function publicRoom(
  known: RepositoryText | undefined,
  room: { left: number },
): ((query: string) => boolean) | undefined {
  if (known === undefined) return undefined;
  return (query) => {
    if (!known.has(query)) return false;
    if (room.left === 0) return true;
    room.left -= 1;
    return false;
  };
}

async function fillDistinct(
  llm: LlmClient,
  prompt: (needed: number, avoid: readonly string[]) => string,
  label: string,
  count: number,
  taken: Set<string>,
  excluded: ((query: string) => boolean) | undefined,
): Promise<string[]> {
  const written: string[] = [];
  // A model asked for N searches sometimes repeats itself or an existing
  // one; ask again for the remainder, a bounded number of times.
  for (let attempt = 0; attempt < 3 && written.length < count; attempt += 1) {
    const needed = count - written.length;
    const answer = await llm.completeStructured({
      prompt: prompt(needed, attempt === 0 ? [] : written),
      schema: FILLER_SCHEMA,
      operation: SCORE_FILLER_OPERATION,
    });
    const searches = (answer as { searches?: unknown }).searches;
    if (!Array.isArray(searches)) {
      throw new Error(`score filler: ${label} answer has no searches array`);
    }
    for (const value of searches) {
      if (typeof value !== "string") continue;
      const key = normalizeReuseQuery(value);
      if (key === "" || taken.has(key)) continue;
      taken.add(key);
      if (excluded?.(value)) continue;
      written.push(value.trim());
      if (written.length === count) break;
    }
  }
  if (written.length < count) {
    throw new Error(`score filler: ${label} produced ${written.length} of ${count} distinct searches`);
  }
  return written;
}

/**
 * The text of every tracked file in the repository, for the rule that no
 * search already in the repository may enter a hidden half (YOY-175 AC-1,
 * amended). An added search whose normalized text appears in any tracked
 * file is pinned to the public half, never dropped; the split counts the
 * pins per set and language — counts only, never the text.
 */
export class RepositoryText {
  readonly pinned = new Map<string, number>();

  constructor(private readonly text: string) {}

  /** True when the query's normalized text is in the repository. */
  has(query: string): boolean {
    const normalized = normalizeReuseQuery(query);
    return normalized !== "" && this.text.includes(normalized);
  }

  /** Count `n` searches pinned public under `key` ("simple he"). */
  pin(key: string, n: number): void {
    this.pinned.set(key, (this.pinned.get(key) ?? 0) + n);
  }
}

/** Files larger than this are data dumps, not text a search could have been copied from. */
const REPOSITORY_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read every tracked file under `repoRoot` (`git ls-files`), normalized the
 * way searches are: case-folded, whitespace collapsed. Binary files are skipped.
 */
export function repositoryText(repoRoot: string): RepositoryText {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  const parts: string[] = [];
  for (const path of paths) {
    let content: Buffer;
    try {
      content = readFileSync(resolve(repoRoot, path));
    } catch {
      continue;
    }
    if (content.length > REPOSITORY_FILE_MAX_BYTES || content.includes(0)) continue;
    parts.push(normalizeReuseQuery(content.toString("utf8")));
  }
  return new RepositoryText(parts.join("\n"));
}

/** A language's shopper-shaped log searches, newest first. */
function logOf(logQueries: readonly LogQuery[], language: ScoreLanguage): LogQuery[] {
  if (language === "fr" || language === "es") return [];
  return logQueries
    .filter((entry) => isShopperShaped(entry) && detectLanguage(entry.query) === language)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/**
 * Fill every language of the simple set to its size (AC-2; YOY-175 AC-1:
 * he 75, every other 25): the language's kept entries first, when given —
 * a set reproduced from an earlier build — then its shopper-shaped log
 * queries, newest first (YOY-141 AC-12), then model filler in the 60 / 30 /
 * 10 shape mix for the remainder. Every entry carries `set: "simple"`.
 *
 * With `known` (YOY-175 AC-1, amended), the log searches are drawn into
 * halves instead of split afterwards: the hidden added searches are the
 * newest whose text appears in no tracked file, up to the added hidden
 * count (he: 25); the public added are the newest remaining log searches,
 * up to the added public count (he: 25). They are written into `halves` —
 * a kept language's old halves, extended — for the split to keep. Filler
 * is written only when the log runs out, and the split places it.
 */
export async function buildScoreSet({
  logQueries,
  llm,
  keep = {},
  known,
  halves = {},
}: {
  logQueries: readonly LogQuery[];
  llm: LlmClient;
  keep?: Partial<Record<ScoreLanguage, readonly ScoreSetEntry[]>>;
  known?: RepositoryText;
  halves?: Partial<Record<ScoreLanguage, OldHalves>>;
}): Promise<ScoreSetEntry[]> {
  const entries: ScoreSetEntry[] = [];
  for (const language of SCORE_LANGUAGES) {
    const size = searchesPerLanguage(language);
    const kept = (keep[language] ?? []).slice(0, size);
    const taken = new Set(kept.map((entry) => normalizeReuseQuery(entry.query)));
    const candidates = logOf(logQueries, language).filter((entry) => !taken.has(normalizeReuseQuery(entry.query)));
    // The added searches' public share: a reproduced language's kept 25 hold 13 of it.
    const addedPublic = publicCount(size) - publicCount(kept.length);
    const addedHidden = size - kept.length - addedPublic;
    let fromLog: LogQuery[];
    let drawn: { publicAdded: LogQuery[]; hiddenAdded: LogQuery[] } | undefined;
    if (known === undefined) {
      fromLog = candidates.slice(0, size - kept.length);
    } else {
      const hiddenAdded = candidates.filter((entry) => !known.has(entry.query)).slice(0, addedHidden);
      const publicAdded = candidates.filter((entry) => !hiddenAdded.includes(entry)).slice(0, addedPublic);
      drawn = { publicAdded, hiddenAdded };
      fromLog = candidates.filter((entry) => hiddenAdded.includes(entry) || publicAdded.includes(entry));
    }
    for (const entry of fromLog) taken.add(normalizeReuseQuery(entry.query));
    const modelWritten = kept.every((entry) => entry.source === "model") && fromLog.length === 0;
    for (const entry of kept) {
      entries.push({ query: entry.query, language, source: entry.source, modelWritten, set: "simple" });
    }
    const added = new Map<LogQuery, ScoreSetEntry>();
    for (const entry of fromLog) {
      const built: ScoreSetEntry = { query: entry.query, language, source: "log", modelWritten, set: "simple" };
      added.set(entry, built);
      entries.push(built);
    }
    // Filler past the drawn public added: a known one is written again, so the hidden half stays unknown.
    const room = { left: addedPublic - (drawn?.publicAdded.length ?? 0) };
    if (drawn !== undefined && known !== undefined) {
      const old = halves[language];
      if (kept.length > 0 && old === undefined) {
        throw new Error(`score set: ${language} keeps searches without their old halves`);
      }
      halves[language] = {
        publicHalf: [...(old?.publicHalf ?? []), ...drawn.publicAdded.map((entry) => added.get(entry)!)],
        hiddenHalf: [...(old?.hiddenHalf ?? []), ...drawn.hiddenAdded.map((entry) => added.get(entry)!)],
      };
      known.pin(`simple ${language}`, drawn.publicAdded.filter((entry) => known.has(entry.query)).length);
    }
    const shapes = fillerShapeCounts(size - kept.length - fromLog.length);
    for (const shape of ["short", "medium", "long"] as const) {
      if (shapes[shape] === 0) continue;
      for (const query of await fillShape(llm, language, shape, shapes[shape], taken, publicRoom(known, room))) {
        entries.push({ query, language, source: "model", modelWritten, set: "simple" });
      }
    }
  }
  return entries;
}

/** The languages the reproduction check covers (YOY-175 AC-1): the two with log searches in the old set. */
export const REPRODUCED_LANGUAGES = ["en", "he"] as const satisfies readonly ScoreLanguage[];

/** One language's reproduction result: the 25 entries when the old public half came back exactly. */
export interface Reproduction {
  language: ScoreLanguage;
  reproduced: boolean;
  /** The old set's 25 entries, rebuilt from the log; present only when reproduced. */
  entries?: ScoreSetEntry[];
  /** The old halves, 13 public and 12 hidden in the old order; present only when reproduced. */
  halves?: OldHalves;
}

/** A reproduced language's old halves, which the split keeps exactly (YOY-175 AC-1, amended). */
export interface OldHalves {
  publicHalf: readonly ScoreSetEntry[];
  hiddenHalf: readonly ScoreSetEntry[];
}

/**
 * Rebuild the old 25-search languages from the log as it stood before
 * `before` (YOY-175 AC-1, founder 2026-10-14): each language's newest 25
 * shopper-shaped searches, split by the old 13 / 12 seeded shuffle, must
 * give back the old public half exactly — same entries, same order. When
 * they do, the hidden 12 are the rest of the same 25 (same seed, same
 * inputs), so the old set is kept whole without ever reading the hidden
 * file. A language that does not reproduce is built fresh. Pure.
 */
export function reproduceOldSet({
  logQueries,
  previousPublic,
  before,
  seed = SCORE_SPLIT_SEED,
}: {
  logQueries: readonly LogQuery[];
  previousPublic: readonly ScoreSetEntry[];
  before: Date;
  seed?: number;
}): Reproduction[] {
  const rebuilt: ScoreSetEntry[] = REPRODUCED_LANGUAGES.flatMap((language) =>
    logOf(
      logQueries.filter((entry) => entry.date.getTime() < before.getTime()),
      language,
    )
      .slice(0, SEARCHES_PER_LANGUAGE)
      .map((entry) => ({ query: entry.query, language, source: "log" as const, modelWritten: false })),
  );
  // The old split, exactly: one seeded shuffle over the languages in order,
  // 13 public per language. en and he come first, so their shuffles do not
  // depend on the languages after them.
  const random = seededRandom(seed);
  return REPRODUCED_LANGUAGES.map((language) => {
    const shuffled = rebuilt.filter((entry) => entry.language === language);
    shuffleInPlace(shuffled, random);
    const oldPublic = previousPublic
      .filter((entry) => entry.language === language && setOf(entry) === "simple")
      .map((entry) => entry.query);
    const mine = shuffled.slice(0, PUBLIC_PER_LANGUAGE).map((entry) => entry.query);
    const reproduced =
      shuffled.length === SEARCHES_PER_LANGUAGE &&
      mine.length === oldPublic.length &&
      mine.every((query, index) => query === oldPublic[index]);
    return reproduced
      ? {
          language,
          reproduced,
          entries: rebuilt.filter((entry) => entry.language === language),
          halves: {
            publicHalf: shuffled.slice(0, PUBLIC_PER_LANGUAGE),
            hiddenHalf: shuffled.slice(PUBLIC_PER_LANGUAGE),
          },
        }
      : { language, reproduced };
  });
}

const HARD_KIND_TEXT: Record<HardKind, string> = {
  reference:
    "a reference to a person or a look rather than a product, e.g. dressing like a celebrity or a character, or a named style",
  lookalike:
    "a look-alike of a well-known fashion brand the shop does not carry, asking for something that looks like that brand",
  occasion: "an occasion or event the outfit is for, without naming a product",
  vague: "a vague or loose wish, a mood or a situation, rather than a product name",
  "two-wishes": "one sentence holding two different wishes at once, such as a product and a separate constraint on it",
};

/**
 * The hard-set filler prompt (YOY-175 AC-2): one kind per request. Its last
 * line keys replay recordings, like the simple set's.
 */
export function hardFillerPrompt(
  language: ScoreLanguage,
  kind: HardKind,
  count: number,
  avoid: readonly string[],
): string {
  return [
    `Write ${count} different searches a shopper might type into an online clothing and accessories store, in ${LANGUAGE_NAMES[language]}.`,
    `Each search is ${HARD_KIND_TEXT[kind]}.`,
    "Write them as real shoppers do: lower case is fine, no numbering, no quotation marks.",
    ...(avoid.length > 0
      ? ["Do not repeat any of these:", ...avoid.map((query) => `- ${query}`)]
      : []),
    "Answer as JSON: {\"searches\": [ ... ]}.",
    `Query: hard ${language} ${kind} ${count}`,
  ].join("\n");
}

/**
 * The hard set (YOY-175 AC-2): 30 model-written searches per language in en
 * and he, the five kinds in equal parts (6 each), each entry carrying
 * `set: "hard"` and its `kind`. `avoid` holds searches already in the
 * simple set, so the two sets share none. With `known`, a search whose text
 * is already in the repository is kept while the public half has room (the
 * split pins it public) and written again past that.
 */
export async function buildHardSet({
  llm,
  avoid = [],
  known,
}: {
  llm: LlmClient;
  avoid?: readonly ScoreSetEntry[];
  known?: RepositoryText;
}): Promise<ScoreSetEntry[]> {
  const perKind = HARD_SEARCHES_PER_LANGUAGE / HARD_KINDS.length;
  const entries: ScoreSetEntry[] = [];
  for (const language of HARD_LANGUAGES) {
    const taken = new Set(avoid.map((entry) => normalizeReuseQuery(entry.query)));
    const room = { left: publicCount(HARD_SEARCHES_PER_LANGUAGE) };
    for (const kind of HARD_KINDS) {
      const written = await fillDistinct(
        llm,
        (needed, seen) => hardFillerPrompt(language, kind, needed, seen),
        `${language}/hard ${kind}`,
        perKind,
        taken,
        publicRoom(known, room),
      );
      for (const query of written) {
        entries.push({ query, language, source: "model", modelWritten: true, set: "hard", kind });
      }
    }
  }
  return entries;
}

/** mulberry32: a tiny seeded PRNG, so the split is reproducible anywhere. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap]!, items[index]!];
  }
}

/**
 * Split each set's languages public `ceil(n / 2)` / hidden `floor(n / 2)`
 * (AC-3; YOY-175 AC-1: 25 → 13 / 12, 75 → 38 / 37, 30 → 15 / 15) by a
 * seeded shuffle: the same set and seed always give the same halves. Each
 * set has its own shuffle from the seed, the simple set first.
 *
 * A reproduced language's old halves are kept exactly (YOY-175 AC-1,
 * amended): its old public searches stay public and its old hidden ones stay
 * hidden, in their old order, and the shuffle splits only the searches added
 * after them — he 50 → 25 / 25, so 38 / 37 in all. An old public search is
 * already in the repository, so it can never enter a hidden half.
 *
 * With `known`, the same holds for every added search (YOY-175 AC-1,
 * amended): one whose text is in any tracked file is pinned to the public
 * half, never dropped, and the shuffle draws the hidden half only from the
 * added searches in no tracked file. The pins are counted on `known`.
 */
export function splitScoreSet(
  entries: readonly ScoreSetEntry[],
  seed: number = SCORE_SPLIT_SEED,
  pinned: Partial<Record<ScoreLanguage, OldHalves>> = {},
  known?: RepositoryText,
): { publicSet: ScoreSetEntry[]; hiddenSet: ScoreSetEntry[] } {
  const publicSet: ScoreSetEntry[] = [];
  const hiddenSet: ScoreSetEntry[] = [];
  for (const name of SCORE_SET_NAMES) {
    const random = seededRandom(seed);
    for (const language of SCORE_LANGUAGES) {
      const own = entries.filter((entry) => setOf(entry) === name && entry.language === language);
      const halves = name === "simple" ? pinned[language] : undefined;
      // The added searches, repository-known ones pinned public and the rest shuffled.
      const splitAdded = (added: ScoreSetEntry[], addedPublic: number) => {
        const repoKnown = added.filter((entry) => known?.has(entry.query) ?? false);
        const free = added.filter((entry) => !(known?.has(entry.query) ?? false));
        shuffleInPlace(free, random);
        const freePublic = addedPublic - repoKnown.length;
        if (freePublic < 0 || freePublic > free.length) {
          throw new Error(`score set: ${name} ${language} cannot pin ${repoKnown.length} repository-known searches public`);
        }
        known?.pin(`${name} ${language}`, repoKnown.length);
        return {
          publicHalf: [...repoKnown, ...free.slice(0, freePublic)],
          hiddenHalf: free.slice(freePublic),
        };
      };
      if (halves === undefined) {
        const split = splitAdded(own, publicCount(own.length));
        publicSet.push(...split.publicHalf);
        hiddenSet.push(...split.hiddenHalf);
        continue;
      }
      const byQuery = new Map(own.map((entry) => [entry.query, entry]));
      const take = (half: readonly ScoreSetEntry[]) =>
        half.map((old) => {
          const entry = byQuery.get(old.query);
          if (entry === undefined) throw new Error(`score set: a kept ${language} search is missing from the set`);
          byQuery.delete(old.query);
          return entry;
        });
      const keptPublic = take(halves.publicHalf);
      const keptHidden = take(halves.hiddenHalf);
      const added = [...byQuery.values()];
      const addedPublic = publicCount(own.length) - keptPublic.length;
      if (addedPublic < 0 || addedPublic > added.length) {
        throw new Error(`score set: ${language} cannot keep its old halves at ${own.length} searches`);
      }
      const split = splitAdded(added, addedPublic);
      publicSet.push(...keptPublic, ...split.publicHalf);
      hiddenSet.push(...keptHidden, ...split.hiddenHalf);
    }
  }
  return { publicSet, hiddenSet };
}

export function encodeHiddenSet(entries: readonly ScoreSetEntry[]): string {
  return Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
}

export function decodeHiddenSet(encoded: string): ScoreSetEntry[] {
  return JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8")) as ScoreSetEntry[];
}

/** The path with every existing ancestor's symlinks resolved. */
function realPathOf(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  for (;;) {
    try {
      return resolve(realpathSync(existing), relative(existing, absolute));
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      existing = parent;
    }
  }
}

/** True when `path` lies inside `root` (or is it), symlinks resolved. */
export function isInsideDirectory(path: string, root: string): boolean {
  const fromRoot = relative(realPathOf(root), realPathOf(path));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export class ScoreSetRefusal extends Error {}

/**
 * Write both halves (AC-3): the public half as JSON at `publicPath`, the
 * hidden half base64-encoded at `hiddenPath`. Every refusal is decided
 * before either file is written, so a refused run writes nothing.
 */
export function writeScoreSets({
  publicSet,
  hiddenSet,
  publicPath,
  hiddenPath,
  repoRoot,
}: {
  publicSet: readonly ScoreSetEntry[];
  hiddenSet: readonly ScoreSetEntry[];
  publicPath: string;
  hiddenPath: string;
  repoRoot: string;
}): void {
  if (isInsideDirectory(hiddenPath, repoRoot)) {
    throw new ScoreSetRefusal(
      "--hidden-out is inside the repository; the hidden set must live outside it",
    );
  }
  const encoded = encodeHiddenSet(hiddenSet);
  if (Buffer.byteLength(encoded, "utf8") >= HIDDEN_MAX_BYTES) {
    throw new ScoreSetRefusal(
      `encoded hidden set is ${Buffer.byteLength(encoded, "utf8")} bytes; it must stay under ${HIDDEN_MAX_BYTES}`,
    );
  }
  mkdirSync(dirname(publicPath), { recursive: true });
  writeFileSync(publicPath, `${JSON.stringify(publicSet, null, 2)}\n`);
  mkdirSync(dirname(hiddenPath), { recursive: true });
  writeFileSync(hiddenPath, encoded);
}
