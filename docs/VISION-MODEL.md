# Vision model for ingestion enrichment (YOY-119)

Decision record for PRD capability 14: which vision model reads product images at
ingestion and turns them into structured attributes. Executed 2026-08-26 as a one-off
Claude Code session under the founder's binding amendment on YOY-119: **Gemini only,
$1.00 spend ceiling, projection posted before any call.** No product code changed; the
harness and sample live under `docs/vision/`.

- Sample: [`docs/vision/sample.json`](vision/sample.json) — 40 products, 95 image URLs.
- Harness: [`docs/vision/compare.mts`](vision/compare.mts) — `npx tsx docs/vision/compare.mts [--dry-run|--rescore]`.
- Raw results: [`docs/vision/results.json`](vision/results.json) — every answer, usage record and score.

## Method

**Sample.** 40 products from the three live catalogs in the shared Neon DB (read only):
16 from the seed store (`unfiltered-dev.myshopify.com`, lookbook shots — a model wearing
a full outfit, one image each), 12 from tentree (Shopify public product JSON, up to 4
images), 12 from White Stuff (Amplience image set, up to 4 images). 29 products are
**contamination-prone** (other garments, shoes, caps or sandals in frame); 12 are
**text-sparse** (description under 80 characters, 8 of them empty). One product
(`listello-short-boot-mud`) has text that contradicts the image ("Color Black" for a
brown suede boot). Images were fetched through `polite-fetch.server.ts` (UA, robots.txt,
one in flight per host) at 1024 px wide; identical bytes went to every model.

**Key.** Hand-labelled per product by inspecting the images: category (from
`packages/engine/src/taxonomy.ts`), primary colour, sleeve length, neckline, garment
length, pattern, material appearance. Each field has one canonical value plus an
`accept` list of also-correct answers (e.g. a shacket may be `jacket` or `top`; "navy"
accepts "blue"). Each product also lists its **non-sold items** with their category and
colours — the basis of the contamination metric.

**Calls.** One `generateContent` request per product per model: all images inline, then
the anchored prompt (title, type, text; "describe ONLY the item being sold"; the
taxonomy's categories and occasions), the same `responseSchema` for every model,
`temperature 0`, `thinking_level: low` (the level the repo already runs intent at,
YOY-109). Cost is computed per call from `usageMetadata` at the paid-tier prices in
`config/ai-prices.json` / the pricing page (2026-08-13) and accumulated with a hard
abort at $1.00.

**Scoring.** A field is correct when the answer equals the key value or any accepted
alternative (whole-word match, so "navy blue" matches "navy"). A product is
**contaminated** when any emitted attribute — category, primary or secondary colour,
pattern, material — belongs to a non-sold item and is not also true of the sold item.
The contamination rate is over the 29 contamination-prone products (the rate over all
40 is also in `results.json`). Latency is wall-clock per request, median over 40.

## Projection vs. actual

| | Projected (posted before the run) | Actual |
|---|---|---|
| Image tokens per image | 1,120 (Gemini 3 default media resolution) | **1,073** (from `promptTokensDetails`) |
| Requests / images | 120 / up to 480 | 120 / 285 (95 images × 3 models) |
| Total spend | ≈ $0.87 at 4 images each; $0.665 for the 95 actual images | **$0.4523** |

All 120 requests succeeded (7 transient retries in total, 1 of them dropping
`thinkingConfig` after a 400; no product failed).

## Decision table

| Model | Category | Primary colour | Sleeve | Neckline | Length | Pattern | Material | **Mean accuracy** | **Contamination rate** (n=29) | **Cost / image** | **Cost / product** | **Median latency / product** | Projected / 1,000 products @ 4 images |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `gemini-3.5-flash-lite` | 100 % | 100 % | 100 % | 92.5 % | 100 % | 95.0 % | 97.5 % | **97.9 %** | **3.4 %** (1/29) | **$0.00048** | **$0.00113** | **5.24 s** | **$1.90** |
| `gemini-3.6-flash` | 100 % | 100 % | 100 % | 95.0 % | 97.5 % | 100 % | 97.5 % | **98.6 %** | **3.4 %** (1/29) | **$0.00132** | **$0.00313** | **5.06 s** | **$5.28** |
| `gemini-3.1-pro-preview` | 100 % | 100 % | 100 % | 95.0 % | 97.5 % | 97.5 % | 100 % | **98.6 %** | **6.9 %** (2/29) | **$0.00297** | **$0.00705** | **14.16 s** | **$11.86** |

Cost per product is the measured mean over the sample (2.4 images per product on
average); the last column extrapolates the measured cost per image to 4 images.

What the misses were (full list per model in `results.json`):

- **All three** read every category and every primary colour correctly, including the
  brown boot whose text says black, the eight empty-description White Stuff products,
  and the socks / belt / necklace / cap accessories.
- The remaining misses are borderline taxonomy calls, not misreadings: a "notch" lapel
  vs. "collar" on the knit blazer, "high-neck" vs. "crew" on a caped dress, "thigh" vs.
  "knee" on a shift dress, "multi" vs. "stripe" on a two-fabric blouse, "print" vs.
  "solid" for a tee with a small embroidered logo.
- **Contamination.** The one product every model failed is the striped shacket worn
  with tan clogs and a green cap: each model listed "brown" (and flash-lite also
  "green") as a *secondary* colour of the jacket. Pro additionally listed "white" for
  the quilted floral jacket worn over a white tee. No model ever emitted a non-sold
  item's **category**, and no model put a non-sold colour into **primary colour**. The
  secondary-colour list is the contamination channel; the flash models were cleaner
  than pro on it.
- Pro's median latency was 2.8× the flash models', and four of its requests needed a
  retry.

## Decision

**Chosen model: `gemini-3.5-flash-lite`** at `thinking_level: low`, default media
resolution, images inline at ≤ 1024 px, one request per product with all images.

Rationale:

1. It matches the pro model on category and colour (100 %) and is within 0.7 points of
   both larger models on mean accuracy — two borderline field calls out of 280. Nothing
   in the misses is a visual failure a larger model fixed.
2. It ties `gemini-3.6-flash` on contamination (1/29) and beats the pro model (2/29).
3. It is **2.8× cheaper than 3.6-flash and 6.2× cheaper than pro**, at the same latency
   as 3.6-flash. Pro is over the PRD's single-digit ceiling at 4 images ($11.86).
4. It is already the repo's classification model (`DEFAULT_CLASSIFICATION_MODEL`), so
   the enrichment path adds no new model ID to operate.

`config/ai-prices.json` entry (YOY-120 owns the edit; the entry already exists with
these values, so YOY-120 may only need to confirm it):

```json
"gemini-3.5-flash-lite": { "inputUsdPerMTok": 0.3, "outputUsdPerMTok": 2.5 }
```

**Projected one-time cost per 1,000 products at 4 images each: ≈ $1.90** (measured
$0.000475 per image × 4 × 1,000; the text prompt and JSON output are inside that
per-image figure because the cost is allocated over images). Even at the projection's
conservative 1,120 tokens per image plus 400 text and 400 output tokens it is $2.34.
Single-digit USD, with room for a second image-resolution tier if a catalog needs it.

Guard rails for the implementation (YOY-120 / capability 14), from what the run showed:

- Keep `secondaryColours` **out of the hard-filter path** or drop it from the schema:
  it is the only attribute any model contaminated.
- Keep the "describe ONLY the item being sold" anchoring and the "trust the images when
  text disagrees" line — they are what made the text-conflict and text-sparse products
  free.
- Handle a `400` on `thinkingConfig` by retrying without it (the harness saw one).

Fallback if flash-lite is ever withdrawn or its price moves: `gemini-3.6-flash`, same
prompt and schema, at ≈ $5.3 per 1,000 products.

## Desk research — two non-Gemini vision models (zero spend, no calls)

Per the binding amendment on YOY-119, no non-Gemini key was created and no call was
made. Everything below is from vendor documentation and published third-party
benchmarks, fetched 2026-08-26. Candidates were picked to match the price band the
Gemini table is in (flash-class): OpenAI's current mini model and Anthropic's current
small model. Neither vendor publishes an MMMU number for these exact tiers on a
first-party page that could be fetched, so the quality row leans on third-party
evals and is marked accordingly.

### A. OpenAI `gpt-5.4-mini`

| # | Dimension | Finding | Source |
|---|---|---|---|
| 1 | Speed | Artificial Analysis: **172 tokens/s output, 5.16 s time-to-first-token** (at `xhigh` reasoning; the TTFT is reasoning time, not network). Roboflow measured **5.35 s average per image task** (#6 fastest of 31). The reasoning effort is configurable (`low` cuts TTFT); no first-party latency figure. | artificialanalysis.ai/models/comparisons/gpt-5-4-mini-vs-claude-4-5-haiku; playground.roboflow.com/models/openai/gpt-5-4-mini |
| 2 | Reasoning quality on published vision benchmarks | No first-party MMMU/MMMU-Pro figure for the *mini* tier is published (openai.com's launch post gives **MMMU-Pro 81.2 %** for full GPT-5.4 only). Third-party: Roboflow Vision Evals overall **63.5 %** (#27 of 31) — identification 78.1 %, OCR 88.1 %, data extraction 82.5 %, reasoning 62.9 % at high effort, object detection 16.1 %. Artificial Analysis Intelligence Index 41 (text-weighted). | openai.com/index/introducing-gpt-5-4 (via Wikipedia summary; page blocks fetch); playground.roboflow.com/models/openai/gpt-5-4-mini; artificialanalysis.ai |
| 3 | Capabilities | Image input: **yes** ("text, image"). Multi-image per call: **yes**, up to 1,500 images / 512 MB per request. Structured JSON output: **yes** (`structured_outputs`, `json_schema` + `strict`) and function calling; structured outputs are supported on GPT-4o-mini and later, so the mini tier qualifies. Image-token accounting: **published formula** — 32×32-px patches, `ceil(w/32)·ceil(h/32)`, × 1.2 multiplier for the 5.4 family; `detail: low` fits the image in 512×512 (≤ 256 patches ≈ 307 tokens), `high` fits 2048×2048 and ≤ 2,500 patches. A 1024×1024 listing image ≈ 1,024 × 1.2 ≈ **1,229 tokens at high**. 400k context, 128k max output. | developers.openai.com/api/docs/models/gpt-5.4-mini; developers.openai.com/api/docs/guides/images-vision; developers.openai.com/api/docs/guides/structured-outputs |
| 4 | Price | **$0.75 / 1M input, $4.50 / 1M output** (cached input $0.075). Per 1024-px image at high detail ≈ 1,229 × $0.75/1M ≈ **$0.00092**; at low detail ≈ $0.00023. Four images + ~500 text tokens + ~300 output ≈ **$0.0053 per product → ≈ $5.3 per 1,000 products** (single-digit USD, but 2.7× our Gemini pick). | developers.openai.com/api/docs/pricing |

**Worth testing later: yes, but only if a quality gap shows up in production.** It is the
only candidate with a published per-image token formula *and* a `low`-detail switch that
would bring a 4-image product to ≈ $1.2 per 1,000 — comparable to Gemini flash-lite —
and structured outputs are first-class. Against it: the third-party vision score is
middling for its class, the `xhigh` TTFT of ~5 s is far above Gemini's per-product
latency measured here, and it costs 2.7× the chosen model at equal detail. Test it if
the Gemini pick's contamination or colour accuracy degrades on real catalogs.

### B. Anthropic `claude-haiku-4-5`

| # | Dimension | Finding | Source |
|---|---|---|---|
| 1 | Speed | Artificial Analysis: **98 tokens/s output, 0.77 s time-to-first-token** (non-reasoning mode); Anthropic's launch post quotes customers at "up to 4–5× faster than Sonnet 4.5". Roboflow measured **3.15 s average per image task**. | artificialanalysis.ai/models/comparisons/gpt-5-4-mini-vs-claude-4-5-haiku; anthropic.com/news/claude-haiku-4-5; playground.roboflow.com/models/anthropic/claude-4-5-haiku |
| 2 | Reasoning quality on published vision benchmarks | First-party: **MMMU 73.2 %** (Anthropic's launch table; Sonnet 4 = 74.4 %, GPT-5 = 84.2 % in the same table, averaged over 10 runs with a 128k thinking budget). Third-party: Roboflow Vision Evals visual-understanding pass rate **58.2 %** (#51 of 77; object understanding 71.4 %, document understanding 77.8 %, object counting 0 %), OCR 61.6 %. Artificial Analysis Intelligence Index 24 (estimate). | anthropic.com/news/claude-haiku-4-5 (table via datacamp.com summary); playground.roboflow.com/models/anthropic/claude-4-5-haiku |
| 3 | Capabilities | Image input: **yes** (base64, URL, or Files API). Multi-image per call: **yes** — 100 images per request on 200k-context models (Haiku 4.5 is 200k), 600 on 1M-context models; max 10 MB per image, 8000×8000 px. Structured JSON output: **yes** — `output_config.format` (JSON schema) or `strict: true` tool schemas. Image-token accounting: **published formula** — 28×28-px patches, `⌈w/28⌉ × ⌈h/28⌉` visual tokens, long edge capped at 1568 px / 1568 tokens on the standard tier (Claude 4.7+ models get 2576 px / 4784 tokens). A 1024×768 listing image ≈ 37 × 28 ≈ **1,036 tokens**; anything larger is downscaled to ≤ 1,568 tokens. | platform.claude.com/docs/en/build-with-claude/vision; claude-api skill model table |
| 4 | Price | **$1.00 / 1M input, $5.00 / 1M output**. Per 1024-px image ≈ 1,036 × $1/1M ≈ **$0.00104** (ceiling $0.00157 for larger images). Four images + ~500 text tokens + ~300 output ≈ **$0.0061 per product → ≈ $6.1 per 1,000 products** (single-digit USD, ≈ 3× our Gemini pick). Sonnet 5 ($2 / $10) would be ≈ $12 per 1,000 — over the PRD ceiling at 4 images. | claude.com/pricing (via claude-api skill table, cached 2026-06-24); platform.claude.com/docs/en/build-with-claude/vision |

**Worth testing later: no, not at this tier.** Haiku 4.5's published vision score sits
below the 3.x Gemini flash tier's price/quality point, it is 3× the cost of the chosen
model at 4 images, and its third-party object/counting evals are weak for a "which
garment is being sold" task. The one thing it would buy — the lowest TTFT of any
candidate (0.77 s) — does not matter for a batch ingestion job. Revisit only if a
Sonnet-class model drops into the ≤ $1/1M-input band, or if the ingestion path ever
needs a second-opinion model from a different vendor for contamination arbitration.

## Adjacent findings (not fixed here — scope is per-item)

- `config/ai-prices.json` prices `gemini-3.6-flash` at $1.50 / $7.50; the pricing
  page (2026-08-13) lists $0.75 / $3.75 through 2026-12-31 and $1.50 / $7.50 from
  2027-01-01. The repo is therefore over-metering 3.6-flash by 2× until year end.
- Two White Stuff rows carry `featuredImageUrl` = `.../whitestuff/img404` (the CDN's
  placeholder), so the enrichment path should treat that URL as "no image".
- White Stuff's Amplience image set uses suffixes `FF/FD/FB` (flat), `MF/MB/MD`
  (on-model) and `L` (lifestyle); the same asset can be served under several suffixes,
  so an image list built from suffix probing needs content-hash de-duplication.
- The seed store's product JSON is password-gated (302), so seed products have only
  the featured image available to ingestion.
