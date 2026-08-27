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
import {
  CrawlSetupError,
  createJsonLdCrawlSource,
  DEFAULT_CRAWL_PAGE_BUDGET,
  JSONLD_CRAWL_SOURCE_KIND,
  type JsonLdCrawlSource,
} from "./jsonld-crawl-source.server";
import type { PoliteFetch } from "./polite-fetch.server";
import { RobotsDisallowedError } from "./polite-fetch.server";
import {
  createShopifyPublicSource,
  detectShopifyPublicStore,
  fetchShopifyPublicStoreMeta,
  SHOPIFY_PUBLIC_SOURCE_KIND,
} from "./shopify-public-source.server";

/**
 * `npm run ingest:public` (YOY-88 AC-6/AC-7), minus process wiring: argument
 * parsing, source detection, the run itself, and the operator report — all
 * injectable (fetch, DB, AI clients, log) so the CLI is tested end to end
 * offline. scripts/ingest-public.mts is the thin process entrypoint.
 */

export const INGEST_PUBLIC_USAGE = [
  "usage: npm run ingest:public -- --url <store URL> --slug <slug> [--name \"<Store>\"] [--max <N>] [--source shopify-public|jsonld-crawl] [--pages <N>] [--path-prefix </locale/>]",
  "       npm run ingest:public -- --delete --slug <slug>",
].join("\n");

/** The sources the CLI can force with `--source` (YOY-89 AC-5). */
export const SOURCE_KINDS = [SHOPIFY_PUBLIC_SOURCE_KIND, JSONLD_CRAWL_SOURCE_KIND] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface IngestPublicArgs {
  url: string | null;
  slug: string;
  name: string | null;
  max: number;
  delete: boolean;
  /** Forced source, or null for detection. */
  source: SourceKind | null;
  /** Page-fetch budget for the crawler (`--pages`, YOY-89 AC-1). */
  pages: number;
  /**
   * Locale/path hint (`--path-prefix`, YOY-117 AC-4): the crawler fetches
   * only page URLs under it (sitemap discovery unchanged); the Shopify feed
   * and product URLs are read under `<origin><prefix>`. Normalised to a
   * leading slash and no trailing slash; null when not given.
   */
  pathPrefix: string | null;
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
    source: null,
    pages: DEFAULT_CRAWL_PAGE_BUDGET,
    pathPrefix: null,
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
      case "--source": {
        const raw = takeValue();
        if (!(SOURCE_KINDS as readonly string[]).includes(raw)) {
          throw new IngestPublicUsageError(
            `--source must be one of ${SOURCE_KINDS.join("|")}, got "${raw}"`,
          );
        }
        args.source = raw as SourceKind;
        break;
      }
      case "--pages": {
        const raw = takeValue();
        const pages = Number(raw);
        if (!Number.isInteger(pages) || pages <= 0) {
          throw new IngestPublicUsageError(`--pages must be a positive integer, got "${raw}"`);
        }
        args.pages = pages;
        break;
      }
      case "--path-prefix": {
        const raw = takeValue();
        args.pathPrefix = normalizePathPrefix(raw);
        if (args.pathPrefix === null) {
          throw new IngestPublicUsageError(
            `--path-prefix must be a path starting with "/", got "${raw}"`,
          );
        }
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
 * Normalise a `--path-prefix` value (YOY-117 AC-4): a leading slash, no
 * trailing slash, no query or fragment. Returns null for anything that is
 * not a plain path ("uk", "", "/uk?x", "https://…").
 */
export function normalizePathPrefix(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || /[?#\s]/.test(trimmed) || trimmed.includes("://")) {
    return null;
  }
  const collapsed = trimmed.replace(/\/+/g, "/").replace(/\/+$/, "");
  return collapsed === "" ? null : collapsed;
}

/**
 * Detect which source reads `url` (YOY-88 AC-6, extended by YOY-89 AC-5):
 * a Shopify storefront (public feed answers) uses the Shopify adapter; any
 * other URL uses the generic JSON-LD crawler. `force` picks one regardless
 * of detection — forcing `shopify-public` on a non-Shopify URL is the
 * unsupported case (null). Detection goes through the polite fetch, so a
 * robots-disallowed feed surfaces as `RobotsDisallowedError` here rather
 * than as "unsupported".
 */
export async function detectCatalogSource({
  url,
  fetch,
  name,
  force = null,
  pages = DEFAULT_CRAWL_PAGE_BUDGET,
  pathPrefix = null,
}: {
  url: string;
  fetch: PoliteFetch;
  name: string | null;
  force?: SourceKind | null;
  pages?: number;
  /** `--path-prefix` (YOY-117 AC-4), already normalised. */
  pathPrefix?: string | null;
}): Promise<{ source: CatalogSource; name: string } | null> {
  const isShopify =
    force === JSONLD_CRAWL_SOURCE_KIND
      ? false
      : await detectShopifyPublicStore(url, fetch, { pathPrefix });
  if (isShopify) {
    const meta = await fetchShopifyPublicStoreMeta(url, fetch);
    return {
      source: createShopifyPublicSource({ storeUrl: url, fetch, meta, pathPrefix }),
      name: name ?? meta.name ?? new URL(url).host,
    };
  }
  if (force === SHOPIFY_PUBLIC_SOURCE_KIND) {
    return null;
  }
  return {
    source: createJsonLdCrawlSource({ storeUrl: url, fetch, pageBudget: pages, pathPrefix }),
    name: name ?? new URL(url.includes("://") ? url : `https://${url}`).host,
  };
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
    const detected = await detectCatalogSource({
      url,
      fetch,
      name: args.name,
      force: args.source,
      pages: args.pages,
      pathPrefix: args.pathPrefix,
    });
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
    if (detected.source.kind === JSONLD_CRAWL_SOURCE_KIND) {
      const { stats } = detected.source as JsonLdCrawlSource;
      log(
        `crawl: sitemaps ${stats.sitemapsRead}, urls ${stats.urlsDiscovered}, pages fetched ${stats.pagesFetched} (budget ${args.pages}), products found ${stats.productsFound}, skipped no-price ${stats.skippedNoPrice}, non-html ${stats.skippedNonHtml}, robots ${stats.skippedRobots}, outside prefix ${stats.skippedOutsidePrefix}, fetch errors ${stats.fetchErrors}, extract errors ${stats.extractErrors}${
          stats.budgetExhausted ? " — page budget exhausted, more pages remain" : ""
        }`,
      );
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
    if (caught instanceof RobotsDisallowedError || caught instanceof CrawlSetupError) {
      error(`ingest aborted: ${caught.message} — nothing was written`);
      return 1;
    }
    throw caught;
  }
}
