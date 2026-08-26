/**
 * YOY-119 vision-model comparison harness (docs only — not product code).
 *
 * Runs every product in docs/vision/sample.json through each candidate Gemini
 * model with the SAME anchored prompt, the SAME JSON response schema and the
 * SAME inline images, then scores the answers against the hand-labelled key
 * and writes docs/vision/results.json.
 *
 * Secrets: GEMINI_API_KEY is loaded in-process from the main checkout's env
 * file via `process.loadEnvFile` — never printed, never copied. No database
 * access: the sample carries every field the prompt needs. Image bytes come
 * from the catalogs' public CDNs through the repo's polite fetch (UA, robots,
 * one in flight per host, spacing).
 *
 * Spend guard: cost is computed per call from `usageMetadata` at the published
 * paid-tier rates below and accumulated; the run aborts before any call that
 * could push the total past CEILING_USD, and after any call that did.
 *
 * Usage (from the repo root):
 *   npx tsx docs/vision/compare.mts --dry-run            # projection only, no model calls
 *   npx tsx docs/vision/compare.mts                      # full run, writes results.json
 *   npx tsx docs/vision/compare.mts --models gemini-3.5-flash-lite --limit 3
 *   npx tsx docs/vision/compare.mts --rescore            # re-score results.json offline (no spend)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPoliteFetch } from "../../apps/shopify-app/app/playground/polite-fetch.server.ts";
import {
  CANONICAL_CATEGORIES,
  CANONICAL_OCCASIONS,
} from "../../packages/engine/src/taxonomy.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(HERE, "sample.json");
const RESULTS_PATH = path.join(HERE, "results.json");
const ENV_FILE = path.join(os.homedir(), "repos/unfiltered/apps/shopify-app/.env");
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Whole-comparison spend ceiling (founder decision on YOY-119). */
const CEILING_USD = 1.0;
/** Image width requested from the CDN; identical bytes go to every model. */
const IMAGE_WIDTH = 1024;
/** Gemini 3 default media resolution — 1,120 tokens per image (projection only). */
const PROJECTED_TOKENS_PER_IMAGE = 1120;
const PROJECTED_TEXT_TOKENS_PER_PRODUCT = 400;
const PROJECTED_OUTPUT_TOKENS_PER_PRODUCT = 400;
const CONCURRENCY = 3;

/** USD per 1M tokens, paid tier, ai.google.dev/gemini-api/docs/pricing (2026-08-13). */
const PRICES: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> = {
  "gemini-3.5-flash-lite": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  "gemini-3.6-flash": { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 },
  "gemini-3.1-pro-preview": { inputUsdPerMTok: 2.0, outputUsdPerMTok: 12.0 },
};
const DEFAULT_MODELS = Object.keys(PRICES);
const THINKING_LEVEL = "low";

const SLEEVES = ["sleeveless", "short", "three-quarter", "long", "not-applicable"];
const NECKLINES = [
  "crew", "v-neck", "scoop", "collar", "high-neck", "hooded", "boat", "square",
  "asymmetric", "notch", "not-applicable",
];
const LENGTHS = [
  "cropped", "hip", "thigh", "mini", "knee", "midi", "maxi", "ankle", "full",
  "not-applicable",
];

/** The one response schema every model answers with (Gemini responseSchema dialect). */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CANONICAL_CATEGORIES] },
    primaryColour: { type: "string", description: "one lowercase English colour word for the sold item" },
    secondaryColours: { type: "array", items: { type: "string" }, description: "other colours ON THE SOLD ITEM only; [] if none" },
    sleeveLength: { type: "string", enum: SLEEVES },
    neckline: { type: "string", enum: NECKLINES },
    garmentLength: { type: "string", enum: LENGTHS },
    pattern: { type: "string", description: "solid, stripe, check, floral, animal, graphic, print, colour-block, herringbone, quilted, multi" },
    materialAppearance: { type: "string", description: "what the fabric/material LOOKS like: cotton, denim, wool, knit, fleece, leather, suede, silk, jersey, synthetic, metal, ..." },
    occasions: { type: "array", items: { type: "string", enum: [...CANONICAL_OCCASIONS] } },
  },
  required: [
    "category", "primaryColour", "secondaryColours", "sleeveLength", "neckline",
    "garmentLength", "pattern", "materialAppearance", "occasions",
  ],
};

interface KeyField { value: string; accept: string[] }
interface NonSoldItem { item: string; category: string; colours: string[]; pattern?: string; material?: string }
interface SampleProduct {
  id: string; catalog: string; url: string; title: string; productType: string; text: string;
  images: string[]; flags: string[]; key: Record<string, KeyField>; nonSoldItems: NonSoldItem[];
}
interface Sample { fields: string[]; products: SampleProduct[] }

interface Usage { promptTokens: number; outputTokens: number; thoughtTokens: number; imageTokens: number | null; costUsd: number }
interface ProductRun {
  productId: string; ok: boolean; error?: string; attempts: number; latencyMs: number;
  usage: Usage | null; output: Record<string, unknown> | null;
  fieldCorrect?: Record<string, boolean>; contaminated?: boolean; contaminationHits?: string[];
}
interface ModelResult {
  model: string; thinkingLevel: string; runs: ProductRun[];
  metrics?: ReturnType<typeof computeMetrics>;
}
interface Results {
  generatedAt: string; ceilingUsd: number; imageWidth: number; totalCostUsd: number;
  prompt: string; responseSchema: unknown; models: ModelResult[];
}

/** The anchored prompt: title, type, text; describe ONLY the item being sold. */
function buildPrompt(p: SampleProduct): string {
  return [
    "You are labelling ONE fashion e-commerce product for a search index.",
    "The images are the product's own listing photos. They may show a model",
    "wearing OTHER garments, shoes, jewellery or accessories that are NOT for",
    "sale. Describe ONLY the item being sold — the one named by the title and",
    "type below. Never report a colour, pattern, material or category that",
    "belongs to another item in the picture, the model, or the background.",
    "The product text can be sparse or wrong; when text and images disagree",
    "about what you can see, trust the images.",
    "",
    `- category: exactly one of ${CANONICAL_CATEGORIES.join(", ")}.`,
    "- primaryColour: the single dominant colour of the sold item, one",
    "  lowercase English word (black, navy, blue, grey, beige, brown, ...).",
    "- secondaryColours: further colours on the sold item itself, else [].",
    "- sleeveLength, neckline, garmentLength: use \"not-applicable\" for shoes,",
    "  bags, jewellery, accessories and legwear (trousers have no neckline).",
    "- pattern: solid when there is no print.",
    "- materialAppearance: what the material looks like, one word.",
    `- occasions: any of ${CANONICAL_OCCASIONS.join(", ")}.`,
    "Answer as JSON matching the schema.",
    "",
    `Title: ${p.title}`,
    `Type: ${p.productType || "(none)"}`,
    `Text: ${p.text || "(none)"}`,
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const opts = { dryRun: false, rescore: false, models: DEFAULT_MODELS, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--rescore") opts.rescore = true;
    else if (a === "--models") opts.models = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  for (const m of opts.models) if (!PRICES[m]) throw new Error(`no price for ${m} — add it to PRICES first`);
  return opts;
}

function loadSample(limit: number): Sample {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8")) as Sample;
  return { ...sample, products: sample.products.slice(0, Number.isFinite(limit) ? limit : undefined) };
}

function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  return (inputTokens * p.inputUsdPerMTok + outputTokens * p.outputUsdPerMTok) / 1_000_000;
}

function projection(models: string[], products: SampleProduct[]) {
  const imageCount = products.reduce((n, p) => n + p.images.length, 0);
  const rows = models.map((model) => {
    const input = imageCount * PROJECTED_TOKENS_PER_IMAGE + products.length * PROJECTED_TEXT_TOKENS_PER_PRODUCT;
    const output = products.length * PROJECTED_OUTPUT_TOKENS_PER_PRODUCT;
    return { model, requests: products.length, images: imageCount, projectedInputTokens: input, projectedOutputTokens: output, projectedUsd: costUsd(model, input, output) };
  });
  return { rows, totalUsd: rows.reduce((s, r) => s + r.projectedUsd, 0) };
}

// ---------- images ----------

function cdnVariant(url: string): string {
  if (url.includes("amplience.net")) return `${url}?w=${IMAGE_WIDTH}`;
  return `${url}${url.includes("?") ? "&" : "?"}width=${IMAGE_WIDTH}`;
}

async function downloadImages(products: SampleProduct[]) {
  const pf = createPoliteFetch({ contactUrl: "https://github.com/0xYoyo/unfiltered", minSpacingMs: 250 });
  const bytes = new Map<string, { mimeType: string; data: string }>();
  for (const p of products) {
    for (const url of p.images) {
      if (bytes.has(url)) continue;
      const res = await pf.fetch(cdnVariant(url));
      if (!res.ok) throw new Error(`image fetch ${res.status}: ${url}`);
      const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      bytes.set(url, { mimeType: mime.startsWith("image/") ? mime : "image/jpeg", data: buf.toString("base64") });
    }
  }
  return { bytes, stats: pf.stats };
}

// ---------- gemini ----------

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number;
    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  };
  error?: { message?: string };
}

async function callGemini(
  apiKey: string, model: string, prompt: string, images: Array<{ mimeType: string; data: string }>,
  thinking: boolean,
): Promise<{ status: number; body: GeminiResponse; text: string }> {
  const parts: unknown[] = images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
  parts.push({ text: prompt });
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0,
  };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${BASE_URL}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: GeminiResponse = {};
    try { body = JSON.parse(text) as GeminiResponse; } catch { /* non-JSON error body */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- scoring ----------

const norm = (v: unknown) => String(v ?? "").toLowerCase().trim()
  .replace(/gray/g, "grey").replace(/color/g, "colour").replace(/[\s_/]+/g, "-").replace(/[^a-z0-9-]/g, "");

/** Exact or whole-word match ("navy-blue" matches "navy"; "denim" matches "denim"). */
function matches(answer: unknown, wanted: string): boolean {
  const a = norm(answer); const w = norm(wanted);
  if (!a || !w) return false;
  if (a === w) return true;
  return a.split("-").includes(w) || (w.includes("-") && a.includes(w));
}
const matchesAny = (answer: unknown, wanted: string[]) => wanted.some((w) => matches(answer, w));

function scoreRun(p: SampleProduct, fields: string[], out: Record<string, unknown>) {
  const fieldCorrect: Record<string, boolean> = {};
  for (const f of fields) {
    const k = p.key[f];
    fieldCorrect[f] = matchesAny(out[f], [k.value, ...k.accept]);
  }
  const keyColours = [p.key.primaryColour.value, ...p.key.primaryColour.accept];
  const keyCats = [p.key.category.value, ...p.key.category.accept];
  const keyPatterns = [p.key.pattern.value, ...p.key.pattern.accept];
  const keyMaterials = [p.key.materialAppearance.value, ...p.key.materialAppearance.accept];
  const answeredColours = [out.primaryColour, ...(Array.isArray(out.secondaryColours) ? out.secondaryColours : [])];
  const hits: string[] = [];
  for (const item of p.nonSoldItems) {
    if (!keyCats.includes(item.category) && norm(out.category) === norm(item.category)) hits.push(`category=${item.category} (${item.item})`);
    for (const c of item.colours) {
      if (keyColours.some((k) => matches(k, c) || matches(c, k))) continue;
      if (answeredColours.some((a) => matches(a, c))) hits.push(`colour=${c} (${item.item})`);
    }
    if (item.pattern && !keyPatterns.includes(item.pattern) && matches(out.pattern, item.pattern)) hits.push(`pattern=${item.pattern} (${item.item})`);
    if (item.material && !keyMaterials.includes(item.material) && matches(out.materialAppearance, item.material)) hits.push(`material=${item.material} (${item.item})`);
  }
  return { fieldCorrect, contaminated: hits.length > 0, contaminationHits: hits };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeMetrics(model: string, runs: ProductRun[], products: SampleProduct[], fields: string[]) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const ok = runs.filter((r) => r.ok && r.fieldCorrect);
  const accuracyPct: Record<string, number | null> = {};
  for (const f of fields) {
    accuracyPct[f] = ok.length ? Math.round((100 * ok.filter((r) => r.fieldCorrect![f]).length) / ok.length * 10) / 10 : null;
  }
  const fieldValues = Object.values(accuracyPct).filter((v): v is number => v !== null);
  const meanAccuracyPct = fieldValues.length ? Math.round((fieldValues.reduce((a, b) => a + b, 0) / fieldValues.length) * 10) / 10 : null;
  const prone = ok.filter((r) => (byId.get(r.productId)?.nonSoldItems.length ?? 0) > 0);
  const contaminated = ok.filter((r) => r.contaminated).length;
  const images = ok.reduce((n, r) => n + (byId.get(r.productId)?.images.length ?? 0), 0);
  const cost = ok.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0);
  const imageTokens = ok.reduce((s, r) => s + (r.usage?.imageTokens ?? 0), 0);
  const prompt = ok.reduce((s, r) => s + (r.usage?.promptTokens ?? 0), 0);
  const output = ok.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);
  const thoughts = ok.reduce((s, r) => s + (r.usage?.thoughtTokens ?? 0), 0);
  return {
    productsScored: ok.length, productsFailed: runs.length - ok.length,
    accuracyPct, meanAccuracyPct,
    contaminationRatePct: prone.length ? Math.round((100 * contaminated) / prone.length * 10) / 10 : null,
    contaminationRateAllPct: ok.length ? Math.round((100 * contaminated) / ok.length * 10) / 10 : null,
    contaminatedProducts: contaminated, contaminationProneProducts: prone.length,
    costUsdPerImage: images ? cost / images : null,
    costUsdPerProduct: ok.length ? cost / ok.length : null,
    costUsdTotal: cost,
    projectedUsdPer1000ProductsAt4Images: images ? (cost / images) * 4 * 1000 : null,
    medianLatencyMs: median(ok.map((r) => r.latencyMs)),
    tokens: { prompt, output, thoughts, imageTokens, imageTokensPerImage: images && imageTokens ? Math.round(imageTokens / images) : null },
    // How often thinkingConfig had to be dropped (model rejected thinking_level).
    retriedWithoutThinking: runs.filter((r) => r.attempts > 1).length,
  };
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sample = loadSample(opts.limit);
  const products = sample.products;

  if (opts.rescore) {
    const results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8")) as Results;
    for (const m of results.models) {
      for (const r of m.runs) {
        const p = products.find((x) => x.id === r.productId);
        if (p && r.ok && r.output) Object.assign(r, scoreRun(p, sample.fields, r.output));
      }
      m.metrics = computeMetrics(m.model, m.runs, products, sample.fields);
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
    printSummary(results);
    return;
  }

  const proj = projection(opts.models, products);
  console.log("projection:", JSON.stringify(proj, null, 2));
  if (proj.totalUsd > CEILING_USD) {
    console.error(`projection ${proj.totalUsd.toFixed(3)} USD exceeds ceiling ${CEILING_USD} — stopping`);
    process.exit(2);
  }
  if (opts.dryRun) {
    const { bytes, stats } = await downloadImages(products);
    const mb = [...bytes.values()].reduce((s, b) => s + b.data.length * 0.75, 0) / 1e6;
    console.log(`dry run: ${products.length} products, ${bytes.size} images (${mb.toFixed(1)} MB), fetch stats ${JSON.stringify(stats)}; no model calls made`);
    return;
  }

  process.loadEnvFile(ENV_FILE);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing from env file");

  const { bytes, stats } = await downloadImages(products);
  console.log(`images ready: ${bytes.size}, fetch stats ${JSON.stringify(stats)}`);

  const results: Results = {
    generatedAt: new Date().toISOString(), ceilingUsd: CEILING_USD, imageWidth: IMAGE_WIDTH, totalCostUsd: 0,
    prompt: buildPrompt({ ...products[0], title: "<title>", productType: "<type>", text: "<text>" }),
    responseSchema: RESPONSE_SCHEMA, models: [],
  };
  let spent = 0;
  let aborted = false;

  for (const model of opts.models) {
    const runs: ProductRun[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < products.length && !aborted) {
        const p = products[cursor++];
        const images = p.images.map((u) => bytes.get(u)!);
        // Worst-case cost of this call at the projection rates; never start a
        // call that could cross the ceiling.
        const worst = costUsd(model, images.length * PROJECTED_TOKENS_PER_IMAGE * 2 + 2000, 4000);
        if (spent + worst > CEILING_USD) { aborted = true; console.error(`ceiling guard: spent ${spent.toFixed(4)} + worst-case ${worst.toFixed(4)} > ${CEILING_USD}; aborting`); break; }
        const run: ProductRun = { productId: p.id, ok: false, attempts: 0, latencyMs: 0, usage: null, output: null };
        let thinking = true;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          run.attempts += 1;
          const t0 = performance.now();
          let res: Awaited<ReturnType<typeof callGemini>>;
          try {
            res = await callGemini(apiKey, model, buildPrompt(p), images, thinking);
          } catch (e) {
            run.error = `transport: ${e instanceof Error ? e.message : String(e)}`;
            await sleep(2000 * (attempt + 1));
            continue;
          }
          run.latencyMs = Math.round(performance.now() - t0);
          if (res.status === 400 && thinking && /thinking/i.test(res.text)) { thinking = false; run.error = "thinking_level rejected; retried without"; continue; }
          if (res.status === 429 || res.status >= 500) { run.error = `http ${res.status}`; await sleep(3000 * (attempt + 1)); continue; }
          if (res.status !== 200) { run.error = `http ${res.status}: ${res.text.slice(0, 300)}`; break; }
          const u = res.body.usageMetadata;
          if (!u || typeof u.promptTokenCount !== "number") { run.error = "no usageMetadata"; break; }
          const outTok = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
          const imageTok = u.promptTokensDetails?.find((d) => d.modality === "IMAGE")?.tokenCount ?? null;
          const cost = costUsd(model, u.promptTokenCount, outTok);
          spent += cost;
          run.usage = { promptTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0, imageTokens: imageTok, costUsd: cost };
          const text = res.body.candidates?.[0]?.content?.parts?.filter((x) => !x.thought).map((x) => x.text ?? "").join("") ?? "";
          try {
            run.output = JSON.parse(text) as Record<string, unknown>;
            run.ok = true;
            run.error = undefined;
            Object.assign(run, scoreRun(p, sample.fields, run.output));
          } catch {
            run.error = `unparseable JSON (finishReason=${res.body.candidates?.[0]?.finishReason}): ${text.slice(0, 200)}`;
          }
          break;
        }
        runs.push(run);
        console.log(`${model} ${p.id} ok=${run.ok} ${run.latencyMs}ms $${run.usage?.costUsd.toFixed(5) ?? "-"} total=$${spent.toFixed(4)}${run.error ? " " + run.error : ""}`);
        if (spent > CEILING_USD) { aborted = true; console.error(`ceiling reached after call: ${spent.toFixed(4)} > ${CEILING_USD}; aborting`); }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    runs.sort((a, b) => products.findIndex((p) => p.id === a.productId) - products.findIndex((p) => p.id === b.productId));
    const mr: ModelResult = { model, thinkingLevel: THINKING_LEVEL, runs };
    mr.metrics = computeMetrics(model, runs, products, sample.fields);
    results.models.push(mr);
    results.totalCostUsd = spent;
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
    if (aborted) break;
  }
  results.totalCostUsd = spent;
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  printSummary(results);
  if (aborted) process.exit(3);
}

function printSummary(results: Results) {
  for (const m of results.models) {
    console.log(`\n== ${m.model}`);
    console.log(JSON.stringify(m.metrics, null, 2));
  }
  console.log(`\ntotal spend: $${results.totalCostUsd.toFixed(4)}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
