import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient, LlmClient } from "@unfiltered/engine";

import type { CatalogSource } from "./catalog-source.server";
import {
  DEFAULT_MAX_PRODUCTS,
  deletePublicCatalog,
  ingestPublicCatalog,
  isValidCatalogSlug,
  playgroundStoreKey,
} from "./ingest-public.server";
import type { PoliteFetch } from "./polite-fetch.server";
import { RobotsDisallowedError } from "./polite-fetch.server";
import {
  createShopifyPublicSource,
  detectShopifyPublicStore,
  fetchShopifyPublicStoreMeta,
} from "./shopify-public-source.server";

/**
 * `npm run ingest:public` (YOY-88 AC-6/AC-7), minus process wiring: argument
 * parsing, source detection, the run itself, and the operator report — all
 * injectable (fetch, DB, AI clients, log) so the CLI is tested end to end
 * offline. scripts/ingest-public.mts is the thin process entrypoint.
 */

export const INGEST_PUBLIC_USAGE = [
  "usage: npm run ingest:public -- --url <store URL> --slug <slug> [--name \"<Store>\"] [--max <N>]",
  "       npm run ingest:public -- --delete --slug <slug>",
].join("\n");

export interface IngestPublicArgs {
  url: string | null;
  slug: string;
  name: string | null;
  max: number;
  delete: boolean;
}

/** Thrown for a malformed command line; the message is the whole report. */
export class IngestPublicUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${INGEST_PUBLIC_USAGE}`);
    this.name = "IngestPublicUsageError";
  }
}

/** Parse `argv` (after the script path): `--url`, `--slug`, `--name`, `--max`, `--delete`. */
export function parseIngestPublicArgs(argv: string[]): IngestPublicArgs {
  const args: IngestPublicArgs = {
    url: null,
    slug: "",
    name: null,
    max: DEFAULT_MAX_PRODUCTS,
    delete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const takeValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new IngestPublicUsageError(`${flag} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--url":
        args.url = takeValue();
        break;
      case "--slug":
        args.slug = takeValue();
        break;
      case "--name":
        args.name = takeValue();
        break;
      case "--max": {
        const raw = takeValue();
        const max = Number(raw);
        if (!Number.isInteger(max) || max <= 0) {
          throw new IngestPublicUsageError(`--max must be a positive integer, got "${raw}"`);
        }
        args.max = max;
        break;
      }
      case "--delete":
        args.delete = true;
        break;
      default:
        throw new IngestPublicUsageError(`unknown argument "${flag}"`);
    }
  }
  if (args.slug === "") {
    throw new IngestPublicUsageError("--slug is required");
  }
  if (!isValidCatalogSlug(args.slug)) {
    throw new IngestPublicUsageError(
      `--slug must match [a-z0-9-]{1,40}, got "${args.slug}"`,
    );
  }
  if (!args.delete && args.url === null) {
    throw new IngestPublicUsageError("--url is required unless --delete is given");
  }
  return args;
}

/**
 * Detect which source can read `url` (AC-6): today only the Shopify public
 * feed. Null means no supported source — the CLI exits non-zero. Detection
 * goes through the polite fetch, so a robots-disallowed feed surfaces as
 * `RobotsDisallowedError` here rather than as "unsupported".
 */
export async function detectCatalogSource({
  url,
  fetch,
  name,
}: {
  url: string;
  fetch: PoliteFetch;
  name: string | null;
}): Promise<{ source: CatalogSource; name: string } | null> {
  if (await detectShopifyPublicStore(url, fetch)) {
    const meta = await fetchShopifyPublicStoreMeta(url, fetch);
    return {
      source: createShopifyPublicSource({ storeUrl: url, fetch, meta }),
      name: name ?? meta.name ?? new URL(url).host,
    };
  }
  return null;
}

/**
 * Run the CLI. Returns the process exit code; every line of output goes
 * through `log`/`error`. Never throws for the operator-facing failures
 * (usage, unsupported URL, robots, missing currency) — those are reported
 * as one actionable line and exit code 1.
 */
export async function runIngestPublicCli({
  argv,
  db,
  fetch,
  aiClients,
  log = console.log,
  error = console.error,
  now = new Date(),
}: {
  argv: string[];
  db: PrismaClient;
  fetch: PoliteFetch;
  /**
   * The engine ports the enrichment and embedding steps run through, built
   * lazily: the metered Gemini clients need GEMINI_API_KEY at construction,
   * which `--delete` and a failed detection must not require.
   */
  aiClients: () => { llm: LlmClient; embeddings: EmbeddingClient };
  log?: (line: string) => void;
  error?: (line: string) => void;
  now?: Date;
}): Promise<number> {
  let args: IngestPublicArgs;
  try {
    args = parseIngestPublicArgs(argv);
  } catch (caught) {
    if (caught instanceof IngestPublicUsageError) {
      error(caught.message);
      return 1;
    }
    throw caught;
  }

  if (args.delete) {
    const deleted = await deletePublicCatalog({ db, slug: args.slug });
    log(
      `deleted catalog ${args.slug} (${deleted.storeKey}): products ${deleted.products}, enrichments ${deleted.enrichments}, embeddings ${deleted.embeddings}, registry ${deleted.registry}`,
    );
    return 0;
  }

  const url = args.url as string;
  try {
    const detected = await detectCatalogSource({ url, fetch, name: args.name });
    if (detected === null) {
      error(`no supported catalog source for ${url}`);
      return 1;
    }
    log(`catalog: ${args.slug} (${playgroundStoreKey(args.slug)})`);
    log(`source: ${detected.source.kind} at ${url}`);
    log(`name: ${detected.name}`);
    const { llm, embeddings } = aiClients();
    const result = await ingestPublicCatalog({
      db,
      slug: args.slug,
      name: detected.name,
      source: detected.source,
      sourceUrl: url,
      maxProducts: args.max,
      llm,
      embeddings,
      now,
      onProgress: ({ fetched, stage }) => log(`fetched ${fetched} (${stage})`),
    });
    log(
      `ingest: created ${result.ingest.created}, updated ${result.ingest.updated}, unchanged ${result.ingest.unchanged}, deleted ${result.ingest.deleted}`,
    );
    if (result.ingest.skippedOverMax > 0) {
      log(
        `skipped ${result.ingest.skippedOverMax} product(s) beyond --max ${args.max} (paging stopped at the first page past the bound; more may exist)`,
      );
    }
    if (result.ingest.skippedInvalid > 0) {
      log(`skipped ${result.ingest.skippedInvalid} product(s) with no title or no price`);
    }
    log(
      `enrich: enriched ${result.enrich.enriched}, cached ${result.enrich.cached}, failed ${result.enrich.failed}`,
    );
    log(
      `embed: embedded ${result.embed.embedded}, cached ${result.embed.cached}, deleted ${result.embed.deleted}`,
    );
    const cost = await db.aiCall.aggregate({
      _sum: { costUsd: true },
      _count: { _all: true },
      where: { shopDomain: result.storeKey, createdAt: { gte: now } },
    });
    log(
      `ai cost this run: $${(cost._sum.costUsd ?? 0).toFixed(6)} over ${cost._count._all} call(s)`,
    );
    log(
      `requests: ${fetch.stats.requests}, retries: ${fetch.stats.retries}, robots-skipped: ${fetch.stats.robotsSkipped}`,
    );
    return 0;
  } catch (caught) {
    if (caught instanceof RobotsDisallowedError) {
      error(`ingest aborted: ${caught.message} — nothing was written`);
      return 1;
    }
    throw caught;
  }
}
