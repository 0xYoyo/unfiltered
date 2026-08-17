import { gunzipSync } from "node:zlib";

import type { PoliteFetch } from "./polite-fetch.server";

/**
 * Sitemap discovery and expansion (YOY-89 AC-1): the page-URL list a public
 * store publishes for crawlers. Discovery reads `robots.txt` `Sitemap:`
 * lines, else `/sitemap.xml`; sitemap indexes are followed recursively;
 * gzipped sitemaps (`.xml.gz`, or a gzip body) are inflated. Parsing is a
 * small tag scan — sitemaps are `<sitemapindex>`/`<urlset>` with `<loc>`
 * children, and a full XML parser would be a dependency for nothing.
 * Platform-free: URLs in, URLs out.
 */

/** Product-ish URL path patterns, fetched first (AC-2). */
export const PRODUCT_PATH_PATTERNS = ["/product/", "/products/", "/p/", "/item/", "/shop/"];

export function isProductishUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return PRODUCT_PATH_PATTERNS.some((pattern) => path.includes(pattern));
  } catch {
    return false;
  }
}

/** Order URLs product-ish first, stable within each group (AC-2). */
export function prioritizeUrls(urls: string[]): string[] {
  const productish: string[] = [];
  const rest: string[] = [];
  for (const url of urls) {
    (isProductishUrl(url) ? productish : rest).push(url);
  }
  return [...productish, ...rest];
}

/** `Sitemap:` lines of a robots.txt body, in order. */
export function sitemapsFromRobots(robotsBody: string): string[] {
  const found: string[] = [];
  for (const rawLine of robotsBody.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^sitemap\s*:\s*(\S+)/i.exec(line);
    if (match !== null) {
      found.push(match[1]);
    }
  }
  return found;
}

/** Parsed sitemap: child sitemaps (an index) and/or page URLs (a urlset). */
export interface ParsedSitemap {
  sitemaps: string[];
  urls: string[];
}

const decodeXml = (text: string): string =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

/** Scan a sitemap document for `<sitemap><loc>` and `<url><loc>` entries. */
export function parseSitemap(xml: string): ParsedSitemap {
  const result: ParsedSitemap = { sitemaps: [], urls: [] };
  const entryPattern = /<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entryPattern.exec(xml)) !== null) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(entry[2]);
    if (loc === null) {
      continue;
    }
    const url = decodeXml(loc[1]);
    if (url === "") {
      continue;
    }
    (entry[1].toLowerCase() === "sitemap" ? result.sitemaps : result.urls).push(url);
  }
  return result;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Read a sitemap response as text, inflating gzip bodies (`.xml.gz`, or a
 * gzip-typed / gzip-magic body regardless of extension). */
export async function readSitemapBody(response: Response, url: string): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("Content-Type") ?? "";
  const looksGzip =
    (bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) ||
    /gzip/i.test(contentType) ||
    /\.gz(\?|$)/i.test(url);
  if (looksGzip && bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0]) {
    return gunzipSync(bytes).toString("utf8");
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export interface SitemapDiscovery {
  /** Every sitemap document read, in fetch order (indexes included). */
  sitemaps: string[];
  /** Page URLs collected, deduplicated, in discovery order. */
  urls: string[];
}

/**
 * Discover and expand a site's sitemaps into page URLs. Robots `Sitemap:`
 * lines win; `/sitemap.xml` is the fallback. Indexes recurse (bounded by
 * `maxSitemaps` so a pathological index cannot spin forever). A sitemap
 * that cannot be fetched (404, robots-disallowed, network) is skipped —
 * the crawl works with what it can read; an empty result is the caller's
 * loud failure.
 */
export async function discoverSitemapUrls({
  origin,
  fetch,
  maxSitemaps = 200,
}: {
  origin: string;
  fetch: PoliteFetch;
  maxSitemaps?: number;
}): Promise<SitemapDiscovery> {
  const seeds: string[] = [];
  try {
    const robots = await fetch.fetch(`${origin}/robots.txt`);
    if (robots.ok) {
      seeds.push(...sitemapsFromRobots(await robots.text()));
    }
  } catch {
    // No robots.txt reachable: fall through to the conventional path.
  }
  if (seeds.length === 0) {
    seeds.push(`${origin}/sitemap.xml`);
  }

  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();
  const discovery: SitemapDiscovery = { sitemaps: [], urls: [] };
  const queue = [...seeds];
  while (queue.length > 0 && discovery.sitemaps.length < maxSitemaps) {
    const sitemapUrl = queue.shift() as string;
    if (seenSitemaps.has(sitemapUrl)) {
      continue;
    }
    seenSitemaps.add(sitemapUrl);
    let parsed: ParsedSitemap;
    try {
      const response = await fetch.fetch(sitemapUrl);
      if (!response.ok) {
        continue;
      }
      parsed = parseSitemap(await readSitemapBody(response, sitemapUrl));
    } catch {
      continue;
    }
    discovery.sitemaps.push(sitemapUrl);
    queue.push(...parsed.sitemaps);
    for (const url of parsed.urls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        discovery.urls.push(url);
      }
    }
  }
  return discovery;
}
