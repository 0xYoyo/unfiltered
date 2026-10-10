# Sparse-catalog eval harness

The quality gate for search on a deliberately thin catalog (YOY-27):
deterministic, offline, inside default `npm test`. Two suites share one
fixture catalog and one way of indexing it:

- `harness.test.ts` — the **index eval**: the catalog indexed the way
  production does it, scored on what the vision pass put in the index.
- `constructor-v2.test.ts` — the **Constructor bar**: 30 hard queries
  searched through the production engine over the same index.

Every model and embedding call is answered by the replay clients
(`replay.server.ts`) from the recorded outputs in `fixtures/recorded/`, and
metered into the cost ledger with the recorded model IDs and token counts —
zero network calls, the same ledger shape as a live run. A missing
recording throws: a silent skip would hide a coverage gap.

## The fixture catalog and its index

`fixtures/catalog.json` holds 92 sparse fashion products (EN + HE): one-line
or empty descriptions, ≤ 2 tags, low quality by design (NG-3).

- p67–p78 (YOY-118) are the products the Constructor bar needs: bridal
  gowns (p67, p68) vs. wedding-guest dresses (p69, p70), sleeveless (p71,
  p73) vs. long-sleeve (p72, p74) tops, and multi-material items (p75
  cotton-linen shirt, p76 wool-cashmere coat, p77 nylon down coat, p78
  vegan-leather tote).
- p64–p66 "Rib Knit Top in Pink / in Navy / in Black" are one colourway
  family (YOY-117): the harness seeds them with the same `familyKey` every
  ingestion path computes.
- p62 "Mesh Over Dress in Pink" (colourways pink, black, navy; primary
  pink) and p63 "Tie Waist Dress in Black" carry the primary-colour rule
  (YOY-110).
- p79–p92 (YOY-122) are text-sparse products — title only, no description,
  no tags — each with one listing image in `fixtures/vision/`.

`indexEvalCatalog` (`harness.server.ts`) seeds the snapshot rows and one
`ProductImage` row per fixture image (bytes hashed exactly as image capture
does), then runs the production pipelines over the replay ports: text
enrichment (`recorded/enrichment.json`), the vision pass
(`recorded/vision.json`, images read back through `fixtureImageFetch`), and
the product vectors (`recorded/embeddings.json`, keyed by the exact text
composed from the merged text and vision attributes).

## The index eval (`harness.test.ts`)

`runIndexEval` indexes the catalog on a scratch database and scores:

- **Contamination** (YOY-122 AC-1). `fixtures/vision/cases.json` declares
  11 photos where a model wears other garments, footwear, jewellery or a
  bag beside the sold item; each case names the sold item's categories and
  colours plus every other item's colours. The vision pass's OWN answer
  (`visionAttributes`, before the merge) is scored per case: the category
  must be the sold item's, no answered colour may appear only on the other
  items, and no `styleTag` may name footwear, jewellery or a bag
  (`CONTAMINATION_TERMS`). Bar: 0 violations.
- **Sparse-product goldens** (YOY-122 AC-2). `fixtures/vision-goldens.json`
  holds 12 queries (EN + HE) that ask for an attribute the expected
  products' titles never state — "gold strappy heels under 400", "long
  sleeve dress under 300", "ז'קט עור שחור עד 500". A golden is satisfied
  when one of its expected products was indexed with the facts it asks
  for: its hard constraints hold on the merged enrichment
  (`findViolations`: price, availability, a category admitted by the
  constraint's taxonomy group, occasions and colours not contradicted, the
  primary colour not excluded) and an asked-for colour is stated, not
  unknown (`sparseGaps`). Bar: ≥ 80 % satisfied.
- **Cost.** The vision pass is one-time indexing cost, printed on its own
  line beside the whole indexing run's.

The fixture tests pin the catalog's shape, the contamination cases, the
vision fixtures (every image exists, ≤ 200 KB, with a licence row in
`fixtures/vision/SOURCES.md`) and the Constructor set's sizes.

## The Constructor bar (`constructor-v2.test.ts`)

`fixtures/constructor-goldens.json` (YOY-118): 30 goldens, 15 EN and 15 HE,
in three tagged groups of 10 — `negation` ("summer dress, not white", "top,
no sleeves", "חולצה בלי שרוולים", "winter coat, not wool"), `priceCap`
("under", "below", "מתחת ל", "עד", with and without ₪/$), and
`occasionVsCategory` ("dress for a wedding" → guest dresses and NOT bridal
gowns; "wedding dress" → bridal gowns; "shoes for a wedding", "pants for
the office", and HE equivalents). Each golden carries `expectedProductIds`,
`mustNotProductIds` and its `hardConstraints`; the loader rejects a set
under 24 goldens, 12 per language, or 8 per group.

`runConstructorV2` indexes the catalog as above on its own scratch
database, writes and embeds its cards, and searches every golden through
the production path — find, the wish extraction and the `jev` decision
judge — scoring page 1 (24 results). It asserts:

- a negation golden's excluded products never appear on page 1;
- a price-cap page leads in budget and, within each judge verdict, every
  in-budget product comes before every over-budget one (the engine orders
  by verdict first, `composeWishes`, so an `exact` over-budget product may
  precede a `close` in-budget one; "over budget" is the code's
  `price-near` / `price-far` label against the cap the extraction read);
- a guest-dress query (`co01`, `co03`) never leads with a bridal gown;
- the per-group floor in `fixtures/constructor-floor.json` (`v2`): the hit
  rate (an expected product in the top 10) and the top-10 `mustNot` leak.
  The floor records what the engine does today; tighten it only from a
  measured run, never loosen it to absorb a regression.

Every golden must be served judged and undegraded: offline, anything else
means a recording is missing.

Its recordings: `recorded/card.json` (the card writer, keyed by `Title:`
plus an image digest), `extract.json` (the wish extraction, keyed by
`Query:`), `judge-jev.json` (Jev's per-product decisions, keyed by the
search text plus a digest of the whole request — `decisionRecordingKey`)
and `embeddings-v2.json` (card sections and the goldens' raw sentences; the
same model and dimension as `embeddings.json`, which must agree on any
shared text).

## Regenerating the recordings

Both recorders run only under `LIVE_LLM_TESTS=1` with local keys — never by
default and never in CI, which holds none. Run them from the repository
root: the root `vitest.config.ts` resolves `@unfiltered/*` to the
TypeScript source, while a run started inside `apps/shopify-app` would
score stale compiled `dist/` output (YOY-52 run 6). A source-execution
guard fails loudly before the first paid call if that happens.

### The catalog index — `regenerate-live.test.ts`

Re-records `enrichment.json`, `vision.json` and `embeddings.json` against
the live Gemini APIs, then re-runs the index eval in-process on the fresh
files and fails with every collected finding at once:

    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... npm run regen:live                        # everything
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=catalog npm run regen:live    # every enrichment + vision answer, missing vectors
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=vision npm run regen:live     # every vision answer, missing enrichments + vectors
    LIVE_LLM_TESTS=1 GEMINI_API_KEY=... REGEN_SCOPE=missing npm run regen:live    # only what is missing (a new product)

`catalog` is for an enrichment prompt, schema or rule change, which
invalidates every enrichment recording; `vision` for a vision prompt or
model change, which invalidates every vision answer but no text
enrichment; `missing` for a product added to the catalog, leaving every
existing recording byte-identical. Product texts are composed from the
merged text and vision attributes, so a re-record re-embeds exactly the
products whose text moved; every scope but the default drops the vectors no
product text references any more.

`vision.json` is keyed by `<title>#<digest>` — the product title plus a
short digest of its ordered image bytes (YOY-125 AC-14) — because two
products with the same title and different photos would otherwise share
one recorded answer. Changing a product's images changes its key, so the
entry is re-recorded rather than answered from the old photo. The recorder
and the replay client compute the key identically
(`recordingKeyFromRequest`), so the two cannot drift.

A changed product text changes what the Constructor suite indexes and
searches: re-record its files too (below) before committing.

### The Constructor bar — `constructor-v2-regen.test.ts`

One live run of the same pipeline, against Gemini (cards, wish extraction,
card-section and query vectors) and OpenRouter's Jev (the judge):

    LIVE_LLM_TESTS=1 REGEN_SCOPE=constructor-v2 GEMINI_API_KEY=... OPENROUTER_API_KEY=... \
      npx vitest run apps/shopify-app/app/eval/constructor-v2-regen.test.ts

It replays the committed enrichment, vision and product vectors (so the
index is byte-identical and none of those files changes) and rewrites the
four Constructor files.

Afterwards run `npm test` to prove both suites clear their bars on the
fresh recordings, then commit the changed JSONs.

## Provenance of what is committed

- `enrichment.json` — live `gemini-3.5-flash-lite` output recorded on
  YOY-110 (2026-08-27) with the `primaryColor` prompt.
- `vision.json` — live `gemini-3.5-flash-lite` output at thinking level
  `low` with the anchored anti-contamination prompt, recorded on YOY-122
  (2026-08-27) over the 14 fixture images.
- `embeddings.json` — live `gemini-embedding-001` vectors (768
  dimensions) of the 92 composed product texts.
- `card.json`, `extract.json`, `judge-jev.json`, `embeddings-v2.json` — one
  live run on YOY-153 (2026-10-04), judge `typesafe/jev-1.13`.
