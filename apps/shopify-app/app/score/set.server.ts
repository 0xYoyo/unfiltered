import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@unfiltered/engine";

import { normalizeReuseQuery } from "../search/events.server";

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
 * Every submitted search of the given store keys (AC-1): SearchEvent holds
 * one row per submitted search and none for previews. De-duplicated on the
 * normalized text, keeping each query's first occurrence, oldest first.
 */
export async function exportLogQueries(
  db: PrismaClient,
  storeKeys: readonly string[],
): Promise<LogQuery[]> {
  if (storeKeys.length === 0) {
    return [];
  }
  const rows = await db.searchEvent.findMany({
    where: { shopDomain: { in: [...storeKeys] } },
    select: { query: true, shopDomain: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const seen = new Set<string>();
  const queries: LogQuery[] = [];
  for (const row of rows) {
    const key = normalizeReuseQuery(row.query);
    if (key === "" || seen.has(key)) continue;
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

async function fillShape(
  llm: LlmClient,
  language: ScoreLanguage,
  shape: FillerShape,
  count: number,
  taken: Set<string>,
): Promise<string[]> {
  const written: string[] = [];
  // A model asked for N searches sometimes repeats itself or an existing
  // one; ask again for the remainder, a bounded number of times.
  for (let attempt = 0; attempt < 3 && written.length < count; attempt += 1) {
    const needed = count - written.length;
    const answer = await llm.completeStructured({
      prompt: fillerPrompt(language, shape, needed, attempt === 0 ? [] : written),
      schema: FILLER_SCHEMA,
      operation: SCORE_FILLER_OPERATION,
    });
    const searches = (answer as { searches?: unknown }).searches;
    if (!Array.isArray(searches)) {
      throw new Error(`score filler: ${language}/${shape} answer has no searches array`);
    }
    for (const value of searches) {
      if (typeof value !== "string") continue;
      const key = normalizeReuseQuery(value);
      if (key === "" || taken.has(key)) continue;
      taken.add(key);
      written.push(value.trim());
      if (written.length === count) break;
    }
  }
  if (written.length < count) {
    throw new Error(
      `score filler: ${language}/${shape} produced ${written.length} of ${count} distinct searches`,
    );
  }
  return written;
}

/**
 * Fill every language to exactly 25 searches (AC-2): its log queries first
 * (the oldest 25 when there are more), then model filler in the 60 / 30 / 10
 * shape mix for the remainder.
 */
export async function buildScoreSet({
  logQueries,
  llm,
}: {
  logQueries: readonly LogQuery[];
  llm: LlmClient;
}): Promise<ScoreSetEntry[]> {
  const entries: ScoreSetEntry[] = [];
  for (const language of SCORE_LANGUAGES) {
    const fromLog =
      language === "fr" || language === "es"
        ? []
        : logQueries
            .filter((entry) => detectLanguage(entry.query) === language)
            .slice(0, SEARCHES_PER_LANGUAGE);
    const modelWritten = fromLog.length === 0;
    const taken = new Set(fromLog.map((entry) => normalizeReuseQuery(entry.query)));
    for (const entry of fromLog) {
      entries.push({ query: entry.query, language, source: "log", modelWritten });
    }
    const shapes = fillerShapeCounts(SEARCHES_PER_LANGUAGE - fromLog.length);
    for (const shape of ["short", "medium", "long"] as const) {
      if (shapes[shape] === 0) continue;
      for (const query of await fillShape(llm, language, shape, shapes[shape], taken)) {
        entries.push({ query, language, source: "model", modelWritten });
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

/**
 * Split each language 13 public / 12 hidden (AC-3) by a seeded shuffle: the
 * same set and seed always give the same halves.
 */
export function splitScoreSet(
  entries: readonly ScoreSetEntry[],
  seed: number = SCORE_SPLIT_SEED,
): { publicSet: ScoreSetEntry[]; hiddenSet: ScoreSetEntry[] } {
  const random = seededRandom(seed);
  const publicSet: ScoreSetEntry[] = [];
  const hiddenSet: ScoreSetEntry[] = [];
  for (const language of SCORE_LANGUAGES) {
    const shuffled = entries.filter((entry) => entry.language === language);
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    publicSet.push(...shuffled.slice(0, PUBLIC_PER_LANGUAGE));
    hiddenSet.push(...shuffled.slice(PUBLIC_PER_LANGUAGE));
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
