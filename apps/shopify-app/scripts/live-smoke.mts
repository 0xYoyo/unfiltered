/**
 * Daily live smoke on the deployment (YOY-112): four read-only probes
 * against the real service, run by a Claude Code cloud routine once a day
 * (docs/SMOKE.md) and by anyone with a terminal. It is a canary between
 * milestone live runs, not a benchmark: one run, four verdicts, exit code.
 *
 * Read-only by construction: every probe is a GET with a fresh `sessionId`;
 * nothing here writes to the repository, Linear, or the database (the
 * deployment logs the two submitted searches as SearchEvents, as it does for
 * any visitor — that is the deployment's behaviour, not this script's).
 *
 *   (1) GET /healthz → HTTP 200 and `engine.version` equals the `version`
 *       exported by packages/engine/src/index.ts — the stale-dist class of
 *       regression (YOY-104).
 *   (2) preview `dress` (`mode=preview`, the keystroke preview) →
 *       route=classic, not degraded, ≥ 1 result, 0 chips,
 *       details.latencyMs ≤ classicMaxMs — the keyword-path canary: keyword
 *       only, zero model calls (YOY-153 AC-4).
 *   (3) EN `elegant evening dress under 400`, submitted → the Engine v2
 *       shape: not degraded, ≥ 1 result, `page` and `totalCount` present,
 *       details.engine "v2", latencyMs ≤ aiMaxMs (YOY-153 AC-4). No route
 *       or chip assertion: under v2 the route says whether the judge ran,
 *       and the chips are the shopper's own wishes.
 *   (4) HE `שמלה אלגנטית לערב מתחת ל-400`, submitted → the same assertions.
 *
 * Ceilings come from scripts/live-smoke.config.json. Every probe runs even
 * after an earlier failure, so one alert carries the whole picture. Output:
 * the JSON report, then a one-screen summary; exit 0 when all four pass,
 * exit 1 otherwise.
 *
 * Usage, from apps/shopify-app:
 *
 *   npx tsx scripts/live-smoke.mts --url https://unfiltered-eu.onrender.com
 *   npx tsx scripts/live-smoke.mts            # --url defaults to the config's url
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SmokeConfig {
  url: string;
  classicMaxMs: number;
  aiMaxMs: number;
}

export interface ProbeResult {
  name: "healthz" | "preview" | "ai-en" | "ai-he";
  pass: boolean;
  searchId: string | null;
  latencyMs: number | null;
  route: string | null;
  routeReason: string | null;
  chips: number | null;
  /** `details.engine` as answered; null for healthz or when missing. */
  engine: string | null;
  /** Every assertion that failed, in order; empty when the probe passed. */
  failures: string[];
}

export interface SmokeReport {
  url: string;
  ranAt: string;
  expectedEngineVersion: string;
  probes: ProbeResult[];
  passed: number;
  failed: number;
  exitCode: 0 | 1;
}

/** The query each search probe sends; fixed, so a failure is comparable day to day. */
export const SMOKE_QUERIES = {
  preview: "dress",
  "ai-en": "elegant evening dress under 400",
  "ai-he": "שמלה אלגנטית לערב מתחת ל-400",
} as const;

/** The same shape as `app/playground/polite-fetch.server`'s FetchLike, so a fake store plugs in. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 30_000;

export class SmokeUsageError extends Error {}

export function loadConfig(): SmokeConfig {
  const path = fileURLToPath(new URL("./live-smoke.config.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SmokeConfig;
}

/**
 * The engine version the deployment must report: read from the engine's
 * SOURCE, not its built dist, so a stale dist on either side is exactly
 * what this probe catches.
 */
export function readEngineSourceVersion(): string {
  const path = fileURLToPath(
    new URL("../../../packages/engine/src/index.ts", import.meta.url),
  );
  const match = /export const version = "([^"]+)"/.exec(readFileSync(path, "utf8"));
  if (match === null) {
    throw new Error("packages/engine/src/index.ts exports no `version` constant");
  }
  return match[1]!;
}

export function parseArgs(argv: readonly string[]): { url: string | null } {
  let url: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SmokeUsageError("--url needs a value");
      }
      url = value;
      index += 1;
      continue;
    }
    throw new SmokeUsageError(`unexpected argument: ${token}`);
  }
  return { url };
}

interface PlaygroundBody {
  searchId?: string;
  route?: string;
  degraded?: boolean;
  results?: unknown[];
  chips?: unknown[];
  page?: unknown;
  totalCount?: unknown;
  details?: { routeReason?: string; latencyMs?: number; engine?: string };
}

function emptyResult(name: ProbeResult["name"]): ProbeResult {
  return {
    name,
    pass: false,
    searchId: null,
    latencyMs: null,
    route: null,
    routeReason: null,
    chips: null,
    engine: null,
    failures: [],
  };
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    // Plain GET (fetch's default method): the probes never send a body.
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function probeHealthz(
  fetchImpl: FetchLike,
  base: string,
  expectedVersion: string,
): Promise<ProbeResult> {
  const result = emptyResult("healthz");
  const answer = await getJson(fetchImpl, `${base}/healthz`);
  if ("error" in answer) {
    result.failures.push(`GET /healthz failed: ${answer.error}`);
    return result;
  }
  if (answer.status !== 200) {
    result.failures.push(`GET /healthz answered HTTP ${answer.status}, expected 200`);
  }
  const reported = (answer.body as { engine?: { version?: unknown } } | null)?.engine?.version;
  if (reported !== expectedVersion) {
    result.failures.push(
      `engine.version is ${JSON.stringify(reported ?? null)}, expected "${expectedVersion}" (packages/engine/src/index.ts)`,
    );
  }
  result.pass = result.failures.length === 0;
  return result;
}

async function probeSearch(
  fetchImpl: FetchLike,
  base: string,
  name: Exclude<ProbeResult["name"], "healthz">,
  config: SmokeConfig,
  sessionId: string,
): Promise<ProbeResult> {
  const result = emptyResult(name);
  const query = SMOKE_QUERIES[name];
  const preview = name === "preview";
  const params = new URLSearchParams({ query, sessionId, ...(preview ? { mode: "preview" } : {}) });
  const answer = await getJson(fetchImpl, `${base}/api/playground/search?${params}`);
  if ("error" in answer) {
    result.failures.push(`GET /api/playground/search (${JSON.stringify(query)}) failed: ${answer.error}`);
    return result;
  }
  if (answer.status !== 200) {
    result.failures.push(`search answered HTTP ${answer.status}, expected 200`);
    return result;
  }
  const body = (answer.body ?? {}) as PlaygroundBody;
  result.searchId = typeof body.searchId === "string" ? body.searchId : null;
  result.route = typeof body.route === "string" ? body.route : null;
  result.routeReason = body.details?.routeReason ?? null;
  result.latencyMs = typeof body.details?.latencyMs === "number" ? body.details.latencyMs : null;
  result.chips = Array.isArray(body.chips) ? body.chips.length : null;
  result.engine = typeof body.details?.engine === "string" ? body.details.engine : null;
  const results = Array.isArray(body.results) ? body.results.length : 0;

  if (body.degraded !== false) {
    result.failures.push(`degraded is ${JSON.stringify(body.degraded ?? null)}, expected false`);
  }
  if (results < 1) {
    result.failures.push(`results: ${results}, expected ≥ 1`);
  }
  if (preview) {
    // The keystroke preview is the keyword path on either engine: classic,
    // no chips, no model call.
    if (result.route !== "classic") {
      result.failures.push(`route is ${JSON.stringify(result.route)}, expected "classic"`);
    }
    if (result.chips !== 0) {
      result.failures.push(`chips: ${result.chips ?? "missing"}, expected 0 on the preview`);
    }
  } else {
    // The Engine v2 shape (YOY-153 AC-4): a paged answer from v2.
    if (typeof body.page !== "number") {
      result.failures.push(`page: ${JSON.stringify(body.page ?? null)}, expected a number`);
    }
    if (typeof body.totalCount !== "number") {
      result.failures.push(`totalCount: ${JSON.stringify(body.totalCount ?? null)}, expected a number`);
    }
    if (result.engine !== "v2") {
      result.failures.push(`details.engine is ${JSON.stringify(result.engine)}, expected "v2"`);
    }
  }
  const ceiling = preview ? config.classicMaxMs : config.aiMaxMs;
  const ceilingName = preview ? "classicMaxMs" : "aiMaxMs";
  if (result.latencyMs === null) {
    result.failures.push("details.latencyMs missing");
  } else if (result.latencyMs > ceiling) {
    result.failures.push(`latencyMs ${result.latencyMs} > ${ceilingName} ${ceiling}`);
  }
  result.pass = result.failures.length === 0;
  return result;
}

export interface RunSmokeOptions {
  url: string;
  config: SmokeConfig;
  expectedEngineVersion: string;
  fetch?: FetchLike;
  /** Session id factory; every probe gets a fresh one. */
  sessionId?: () => string;
  now?: () => Date;
}

/** Run all four probes — sequentially, every one even after a failure. */
export async function runSmoke(options: RunSmokeOptions): Promise<SmokeReport> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const sessionId = options.sessionId ?? (() => `smoke-${crypto.randomUUID()}`);
  const base = options.url.replace(/\/+$/, "");
  const probes: ProbeResult[] = [
    await probeHealthz(fetchImpl, base, options.expectedEngineVersion),
    await probeSearch(fetchImpl, base, "preview", options.config, sessionId()),
    await probeSearch(fetchImpl, base, "ai-en", options.config, sessionId()),
    await probeSearch(fetchImpl, base, "ai-he", options.config, sessionId()),
  ];
  const passed = probes.filter((probe) => probe.pass).length;
  return {
    url: base,
    ranAt: (options.now ?? (() => new Date()))().toISOString(),
    expectedEngineVersion: options.expectedEngineVersion,
    probes,
    passed,
    failed: probes.length - passed,
    exitCode: passed === probes.length ? 0 : 1,
  };
}

/** The one-screen summary printed after the JSON report. */
export function formatSummary(report: SmokeReport): string {
  const rows = report.probes.map((probe) => {
    const verdict = probe.pass ? "PASS" : "FAIL";
    const facts = [
      probe.engine === null ? null : `engine=${probe.engine}`,
      probe.route === null ? null : `route=${probe.route}`,
      probe.routeReason === null ? null : `reason=${probe.routeReason}`,
      probe.latencyMs === null ? null : `${probe.latencyMs} ms`,
      probe.chips === null ? null : `chips=${probe.chips}`,
      probe.searchId === null ? null : `searchId=${probe.searchId}`,
    ]
      .filter((fact): fact is string => fact !== null)
      .join(" ");
    const line = `${verdict}  ${probe.name.padEnd(8)} ${facts}`;
    return probe.failures.length === 0
      ? line
      : `${line}\n${probe.failures.map((failure) => `      - ${failure}`).join("\n")}`;
  });
  return [
    `live smoke — ${report.url} — ${report.ranAt}`,
    ...rows,
    `${report.passed}/${report.probes.length} passed → exit ${report.exitCode}`,
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<0 | 1> {
  const config = loadConfig();
  const { url } = parseArgs(argv);
  const report = await runSmoke({
    url: url ?? config.url,
    config,
    expectedEngineVersion: readEngineSourceVersion(),
  });
  console.log(JSON.stringify(report, null, 2));
  console.log("");
  console.log(formatSummary(report));
  return report.exitCode;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof SmokeUsageError ? error.message : error);
      process.exitCode = 1;
    },
  );
}
