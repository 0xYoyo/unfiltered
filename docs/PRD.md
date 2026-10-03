# Unfiltered — PRD
Version: 3.2 · Date: 2026-10-03
Supersedes v2; decisions in docs/RESET-2026-09-27.md. Refinements of
2026-09-30 in §3 Engine v2 (binding where they differ from the text above
them). Amendments of 2026-10-01 (budget rules, hidden-set home, label values,
"in stock", code labels on fallback, the card-writer estimate of ≈ $4 per
1,000 in Refinement 6) are marked inline and bind where they differ.
v3.1 (2026-10-02, YOY-147): §3 Refinement 2 — the merchant-fact label
carries two values, the product's and the asked one, not one parameter.
v3.2 (2026-10-03, YOY-149): the 2026-10-01 amendments are version-bound —
§3 Three kinds of wishes: a stated "in stock" is a firm filter; capability
6: on judge failure the page keeps the code-computed price, size and stock
labels.

Product type: B2B web SaaS, delivered first as a native Shopify app
(self-serve). The engine is catalog-agnostic by design: a universal script
tag serves any site, and other platforms become real integrations when a
paying store asks (docs/RESET-2026-09-27.md §8).

## 1. One-liner
Unfiltered replaces rigid filter-based product search on fashion Shopify
stores with free-text search that understands how humans actually describe
what they want ("elegant summer wedding dress, not black, under ₪400, hides
my belly") — in any language — and proves its value to the merchant in
attributed orders.

## 2. Problem & audience
Shoppers on large-catalog fashion stores can't express what they want
through fixed filters. Research: ~69% of e-commerce visitors use the search
bar immediately, yet ~80% abandon due to unsatisfactory search results.
Incumbent fixes are either enterprise-gated (Algolia NeuralSearch, Elevate
tier only), filter-suite-first with AI sprinkled on (Boost, 1,900+ reviews,
the category incumbent), or young and unproven (Cartally, launched Nov 2025).
Shopify's own free Search & Discovery app offers meaning-based (semantic)
search on the Shopify and Advanced plans, in "multiple languages" (list not
published); its handling of constraints — negation, price, size — is not
documented. Nobody owns fashion specifically; nobody treats multilingual
search seriously; nobody leads with revenue attribution.

Positioning against Shopify Search & Discovery: shop-assistant behaviour
with honest labels, chips, any language, every plan, attributed revenue.

Audience: fashion/apparel Shopify stores with large catalogs (roughly 500+
products), where scrolling and filters genuinely break down. Buyer: the
store owner/manager. End user: their shoppers. Why now: small-model LLM
pricing (~$0.10–0.40 per 1M tokens and falling ~80%/year) makes per-search
AI economically viable at SMB price points for the first time.

> **Positioning note (2026-08-15, binding):** The moat is measured superiority of the core search loop for both shopper and merchant — accuracy, speed, seamlessness, attributed revenue, honest pricing, painless integration. Features (chips, playground, attribution-first onboarding) are proof surfaces that make that superiority visible, not the moat itself; they are prioritized by visibility speed. Hebrew support is a local-sales convenience, never a headline. Pricing posture: sensible-best, not cheapest. See docs/COMPETITORS.md.

## 3. v1 scope
Numbered capabilities, each observable behavior:

1. **One search bar: previews while typing, find-then-judge on submit.**
   The app replaces/augments the store's search box. While the shopper
   types, keyword search returns previews (~50 ms, no LLM call). On submit,
   every search — short or long, any language — runs the one engine
   (find-then-judge, see "Engine v2" below). There is no classic-vs-AI
   switch; the shopper never chooses a mode. Results appear once, when
   ready — no "show classic then swap".
2. **Understanding at load time, comparison at search time.** The engine
   understands the products when they are loaded (a dossier per product)
   and, at search time, compares the shopper's actual words against each
   product's actual facts: find by vector + keyword, then a judge model
   reads the sentence and each candidate together. No fixed intent form,
   no invented category/occasion/attribute lists, no filters on anything a
   model guessed. All languages from day one, with no per-language code; the label templates of Refinement 4 are the one per-language asset.
   Full design: "Engine v2" below.
3. **Filters as output, not input.** Results arrive with the facts the
   shopper stated visibly applied as removable chips (e.g. "Dresses × ·
   Under ₪400 × · Not black ×"). Chips come from a small parallel
   extraction of only what the shopper stated (price + currency, size, in
   stock, explicit "not X"); it is not on the critical path. The shopper
   can remove or adjust chips; each change re-queries the server, which
   returns the counts and pages (server-side counts and pages).
4. **Follow-up refinement in the bar.** After a result set, typing a
   refinement ("same but cheaper", "בלי שרוולים") modifies the previous
   search instead of starting over. Single-session memory only; this is
   not a chatbot.
5. **Catalog ingestion & sync.** On install, the app ingests the store's
   Shopify catalog (titles, descriptions, tags, attributes, price, stock,
   images' alt text) and every variant (the merchant's own option
   name/value pairs, per-variant price and stock), writes a dossier per
   product, builds the multi-vector index, and stays in sync with product
   changes (target: updates reflected within 15 minutes). A changed or
   created product is re-analysed and re-embedded automatically (a "Run
   alone" requirement, milestone 7). One-time indexing cost: see §8 (dossier cost).
6. **Instant fallback.** If the judge misses its deadline or errors, or a
   store exceeds caps, the search bar silently serves the find-stage results
   with the code-computed price, size and stock labels and without the judge's
   labels — never a failure state (amended 2026-10-01). The shopper never sees
   an error state caused by us.
7. **Merchant dashboard.** Shows: total searches, searches where the
   judge missed its deadline, zero-result searches, top queries,
   click-through rate on our results, and the hero metric: search-attributed orders (shopper
   clicked one of our results → purchased that product within the session
   or 24h, via Shopify order webhooks) with currency value.
8. **Onboarding engineered to an activation milestone.** Install →
   catalog indexed → merchant runs one successful search on their own
   products, in under 10 minutes, guided. Paste-URL
   onboarding: paste a store URL → crawl → playground with the store's
   real variants → install for live sync (webhooks).
9. **Review-ask trigger.** The dashboard requests a Shopify review exactly
   once, at the moment the merchant first views a nonzero
   search-attributed-orders figure.
10. **Public demo playground.** A public web page with a real ingested
    fashion catalog where anyone can type free-text queries and see
    results — no install, no login. Supports a mode where a specific
    store's public catalog can be pre-loaded via URL parameter (for
    outreach: "here is YOUR catalog answering human questions").
11. **Cost & abuse controls.** Per-IP/session rate limits on submitted
    searches; identical-query caching; per-store monthly caps on submitted
    searches by plan — when exceeded, the fallback is the find-stage results
    without the judge's labels (code-computed labels remain; amended
    2026-10-01); a global per-store LLM spend ceiling on our side. Real
    cost-per-search is measured and visible in our internal admin from day
    one.
    Model spend: Gemini first; every spend ceiling is proposed with its expected cost and approved by the founder.
12. **Billing.** Shopify-native billing: 14-day free trial (card required,
    capped at 1,000 submitted searches), then tiers per section 8.
13. **App Store listing as a deliverable.** Keyword-researched title/copy
    targeting niche terms ("AI search", "natural language search",
    "fashion search", Hebrew equivalents — not "search", which Boost
    owns), screenshots, and a short demo video sourced from the
    playground. "Built for Shopify" badge requirements are engineering
    constraints from milestone 1 (performance, embedded app standards),
    not a retrofit.
14. **Vision enrichment at ingestion.** Every product's images (all
    images, capped at 4 per product) are analyzed by an accuracy-tier
    vision-capable model at ingestion and on image change (re-analysis
    keyed on image content hash). Extraction is anchored: the prompt
    receives the product's title, type, and text, and must describe ONLY
    the item being sold, ignoring other garments, footwear, and jewelry
    worn by models in the photos. Vision output feeds the product's
    dossier: merchant-stated material comes first; "looks like" from the
    photo is used only when the merchant said nothing, and is marked as
    such. Changed enrichment re-embeds automatically via the composed-text
    freshness hash. This capability is standard on every plan — it is the
    differentiator, not an add-on — with no setup fee; one-time indexing
    cost is absorbed as COGS (measured ceiling: single-digit dollars per
    1,000 products). **Measured 2026-08-27 (YOY-121 AC-7)** on the live
    seed catalog — 465 products, 1,787 images, `gemini-3.5-flash-lite` at
    `thinking_level: low`, one request per product with all images
    inline: **$0.000474 per image, $1.90 per 1,000 products at 4 images
    each** (text re-enrichment adds $0.41 and re-embedding $0.02 per
    1,000, ≈ $2.33 per 1,000 for a full first-time index); 0 of 465
    products failed the vision pass. Evidence on YOY-121.

**Parity floor (added 2026-08-10).** Any capability directly comparable
to the incumbent search experience — plain keyword lookup, typo
handling, result relevance on simple queries, empty states,
responsiveness feel — must be at parity or better with the storefront's
stock search for the same query. The AI tier only ever upgrades the
baseline; it never gates, degrades, or replaces it with something worse.
A regression against the stock experience on a simple query is a launch
blocker, and every milestone touching the shopper path verifies this in
its live-run tail.
v3 note: 'classification, AI understanding, chips, refinement, rescue' now
means the single judged path of §3 Engine v2; 'the AI tier' means that path.

**Self-removal kill switch (added 2026-08-10).** Capability 6 covers
AI-call failures; this covers genuine application bugs. If Unfiltered
itself is broken in a way that impairs a store's ability to search at
all, the widget must be able to fully disable itself — per store,
remotely, and automatically on repeated hard failures — restoring the
store's native search untouched, without a theme edit or reinstall.
Merchants never inherit our downtime. Mechanism specced with M7's
operational work.

**Interaction model (decided 2026-08-10, implemented in YOY-68,
pre-M4).** While the shopper types, the bar behaves like a normal search
bar: live, debounced, classic-only results per keystroke — free and
instant. The full Unfiltered pipeline (classification, AI understanding,
chips, refinement, rescue) fires only on explicit submit (Enter or the
magnifier). Keystroke previews consume no AI budget and are not logged
as searches.
v3 note: 'classification, AI understanding, chips, refinement, rescue' now
means the single judged path of §3 Engine v2; 'the AI tier' means that path.

**Portability constraint (binding, 2026-08-13):** v1 is built
Shopify-first, but every shopper-facing mechanism must state its
generic-store (Door 2) analog at design time. Shopify-specific code is an
adapter around a generic mechanism, never the mechanism itself. A design
whose generic analog cannot be stated is rejected at spec time. The
pre-Door-2 adapter-boundary audit is tracked as YOY-81.

### Engine v2 (v3, 2026-09-28, binding; capabilities 1–3, 5, 14)

Principle: stop understanding the shopper at search time; understand the
products at load time, then compare. A store has finite products; people
ask in infinite ways. The thinking is spent once per product; each search
is a comparison of the shopper's actual words against each product's
actual facts. (docs/RESET-2026-09-27.md §2–§3.)

**Two kinds of product information — and no invented lists.**
- Merchant facts: price, the merchant's own option names and values
  (colour, size, strap length, whatever the store defined), stock per
  variant. Closed by nature, defined by the store. Stored as generic
  name–value pairs.
- Model prose: a free-text dossier per product — what the item is, what
  it looks like, what is printed on it, who buys it, when it is worn;
  merchant-stated material first, "looks like" from the photo only when
  the merchant said nothing, marked as such; plus 20–40 natural ways
  people would ask for it, in several languages.
- The system invents no category list, no occasion list, no attribute
  list. "Skulls" is a word in the prose that the judge reads.

**The query path.**
- Typing previews: keyword search, ~50 ms, unchanged.
- Submit → Find: the raw sentence (any language) becomes one vector; top
  50–150 by vector + keyword matches, merged. Hard filters only on facts
  that can never be a guess: store, active, published. Nothing the model
  guessed removes a product.
- Judge: a model reads the shopper's sentence and each candidate's dossier +
  variants together, and returns per product a short-code answer: verdict
  (exact / same item, other colour or size / close alternative / not
  relevant), missed-wish flags, and a label template id with its values — one
  value, or two for the merchant-fact label (the product's value and the asked
  value, each at most three words, in the language of the shopper's sentence;
  amended 2026-10-01). The label text a shopper sees comes from about five
  templates ("in grey, not black"; "no M — S and L in stock"; "₪319, slightly
  over 300"); size, stock and price labels are computed by code from the
  variants table, not by the judge. Runs on the page being viewed, at the
  store's page size (24 candidates on page 1 by default); page 2 is judged
  when the shopper nears the end of page 1, never in the background. Judge
  answers are cached per (normalized search text, candidate product ids, card
  versions); merchant facts are outside the key. Product rows sent to the
  judge are compact (~80 tokens each).
- Chips: a small parallel extraction pulls out only facts the shopper
  stated (price + currency, size, in stock, explicit "not X") for
  removable chips. Not on the critical path.
- Deleted: the classic-vs-AI switch, the fixed form as source of truth,
  the drop-one-filter ladder, the bridal special case, the colour special
  cases, the Hebrew-specific word lists.
- Results appear once, when ready. No "show classic then swap".

**Three kinds of wishes** (replaces "hard vs soft").
- A number (price, size): never a wall. In-budget first; items within
  ~10 % after them, with the fact shown. Adjacent sizes shown with the
  fact. A wall only on "max", "no more than", "only".
- An exclusion ("not black", "no wool"): firm.
- A stated "in stock": a firm filter — sold-out items are removed from the
  results and the count; removing the chip brings them back (amended
  2026-10-01).
- A description (everything else): judged, never filtered.
Topics are infinite; kinds are three. A new topic never adds code.

**The shop-assistant rule.**
- The judge decides from the prose whether the item is the same kind of
  thing the shopper asked for. Brown pants never answer "brown shirt".
- Merchant facts decide whether it comes in what they asked; misses on
  colour/size/stock are shown on the same item with a label.
- "Only black" / "must be M" moves that wish into the firm set for this
  search.

**Two meanings.**
- Most ambiguity resolves from what the store sells (no bridal gowns →
  guest dresses).
- When both meanings have stock: show the likelier meaning; one tappable
  chip at the top switches ("Bridal gowns instead?"). No popup, no
  blocking question.

**Scale and server-side pages.**
- Vector find is sub-100 ms at millions of products.
- Judge cost scales with pages viewed, not catalog size.
- Result counts and pagination come from the server (replaces holding the
  full match set in the browser).

**Languages.** All languages from day one. No per-language code; the label templates of Refinement 4 are the one per-language asset. The hidden test set carries at least EN, HE, AR, RU, FR, ES, each scored
separately so no language hides in an average.

**Image search.** After the multi-vector index exists: one image vector
per product photo; the shopper uploads/pastes a photo → nearest products;
the judge may compare images. Milestone 8.

**The judge — decision (prices verified 28 Sep 2026).**
- Baseline: Gemini 3.5 Flash-Lite, one call with all page candidates inside, fixed short-code JSON output. Known multilingual, already in the engine. List price $0.30/M input, $2.50/M output. With 24 compact rows (~2–4k tokens in, ~120 tokens out) ≈ $0.001 per uncached search → ≈ $1 per 1,000 searches (estimate; measured in M6). Typically 0.7–1.2 s (measured on our own calls, thinking level low).
- Challenger: Jev (TypeSafe) — typed answers (yes/no with confidence;
  multi-class choice; numeric score), ~0.2 s reported, $0.042/M input,
  output free (via OpenRouter `typesafe/jev-1.13`; Cloudflare Workers AI also lists `typesafe/jev`, not used). ≈ $0.30–0.40 per 1,000 searches. Pointwise
  (parallel questions), labels via multiple choice. Multilingual quality
  unpublished. Available through OpenRouter as `typesafe/jev-1.13`; direct signup paused since 22 Sep 2026. Jev is the margin
  option as well as the speed option — if quality holds.
- Not used: dedicated rerankers (score only, no verdict or labels, and a third vendor). Considered and rejected on 2026-09-30.
- Measured on the hidden score: quality, per-language quality, speed,
  stability (same search ×5). Winner takes page 1; the other is fallback.
  One swap point in code.
- Speed fallback: if the judge misses ~1.5 s, page 1 shows the find-stage
  ranking with the code-computed price, size and stock labels at once; the
  judge's labels are added when it answers (amended 2026-10-01); positions
  never move.

#### Refinements (2026-09-30, binding; override the Engine v2 text above where they differ)

Agreed in the co-manager plan review of 29–30 Sep 2026. Numbers marked
"estimate" are the chat's estimates and are measured in M6.

1. **One judge model.** Gemini 3.5 Flash-Lite, thinking level low, behind one
   swap point in code. The M6 judge comparison tests exactly one challenger:
   Jev via OpenRouter (`typesafe/jev-1.13`; $0.042 per million input tokens,
   output free; 32,000-token context; answers yes/no, pick-one and score
   questions with confidence; no free text; one item per question, so a
   page's candidates are asked in parallel). GPT-5 nano was considered and
   is not tested. No reranker vendor. Winner takes page 1 on the hidden
   score; the other is fallback.
2. **Short-code answers.** The judge answers per product with codes, never
   prose: a verdict (exact / same item, other colour or size / close / not
   relevant), a set of missed-wish flags, and a label template id with its
   values: the merchant-fact label carries two — the product's value and the
   asked value, each at most three words, in the language of the shopper's
   sentence — not one parameter (v3.1; see "The query path", amended
   2026-10-01). Estimate: ≈ $1 per 1,000 uncached searches (replaces
   the $2–4 figure, which assumed prose output).
3. **Labels from code where the fact is the merchant's.** Size, stock and
   price labels are computed by code from the variants table, never by the
   judge. The judge judges the description side only. A stock or price
   change therefore does not invalidate a cached judge answer.
4. **Label templates per kind of miss.** About five templates in total: a
   number missed ("₪319, over your 300"; "no M — S and L in stock"), a
   merchant fact missed ("in grey, not black"), a description missed (one
   generic "close match" line). Exclusions are filtered out, never labelled.
   Templates are translated once per shipped language and are the one
   permitted per-language asset (amends "no per-language code"); a language
   without templates shows no label.
5. **Card (dossier) content.** Facts and visible details from the text and
   the photos are stored as facts; merchant-stated material first, "looks
   like" from the photo only when the merchant said nothing, marked as such.
   Style, occasion and "who wears it" are the model's read: used to find
   candidates and read by the judge, never shown to the shopper, never used
   to reject a product. There is no separate verification pass.
6. **Card writer.** Gemini 3.5 Flash-Lite (estimate ≈ $4 per 1,000 products
   for the text card — revised 2026-10-01 from ≈ $3, the card output is long,
   plus the measured $1.90 per 1,000 for images). A bigger card writer is
   adopted only after a 200-product comparison on the hidden score shows the
   cards are the weak point.
7. **Paging.** The judge runs on the page being viewed, at the store's own
   page size. Page 2 is judged when the shopper nears the end of page 1,
   never pre-judged in the background. The find set is 150 candidates by
   default (a configuration number); beyond the find set, results are
   keyword-ordered. Judged depth is raised if the search log shows shoppers
   going deeper.
8. **Reject-all fallback.** If the judge marks every candidate on a page
   "not relevant", the page shows the find order with the generic label. An
   empty page is never the model's decision alone.
9. **Cold start.** Cards are written in priority order (in stock and recently
   updated first). Until a product's card exists, the find step uses the
   merchant's raw text, so search works from the first minute of onboarding
   and improves as cards land.
10. **Speed knobs, in order, before any new vendor.** Judge 24 candidates on
    page 1; if the judge passes 1.5 s, show the find order at once and add
    labels when they arrive — positions never move. First-build estimate:
    median 1.1–1.3 s; the "half under 1 s" gate is measured, then decided.
11. **Cache key.** Judge answers are cached per (normalized search text,
    candidate product ids, card versions). Merchant facts are outside the
    key (see 3).
12. **Judge log.** Every judge verdict per product per search is stored with
    the click, in one table. Nothing reads it in M6; it exists so the judge
    can later be checked against real shopper clicks.
13. **Refinement.** "Same but cheaper" sends the previous sentence and the
    new one together to the judge and to the chip extraction. No intent
    form.
14. **Multi-vector index.** The one-card-per-colourway-family collapse and
    the small-tenant recall fix (iterative HNSW scan) are re-verified for
    several vectors per product before the index ships.
15. **Old engine recoverable.** The score is measured on the current (M5)
    engine first, as the baseline to beat. `main` is tagged `engine-v1-last`
    before the delete issue merges. The delete issue is last in the engine
    chain and ships only after Engine v2 beats the baseline on the same
    hidden score.
16. **Theme-native label placement** is a docs/DESIGN.md decision inside M6
    (a small muted line under the price, inheriting the theme; nothing when
    it does not fit).

### Quality gate (v3, 2026-09-28, binding)

The hidden human-style score is the release gate (docs/RESET-2026-09-27.md
§5).
- Per catalog, per language: real query logs and friends-and-family
  searches (weighted most) + model-written filler shaped like reality
  (~60 % 1–3 words, 30 % medium, 10 % long/vague). No fanciful phrasings.
- A grader model (Gemini 3.5 Flash-Lite with a fixed rubric) marks each of the top six results of each search 0–3: would a real shopper be happy?
- Half the set is hidden from the builder: it lives in a GitHub Actions
  repository secret and is scored by a dispatch-only workflow that prints
  scores and never query text; the builder never holds the file (amended
  2026-10-01; a repository folder cannot be hidden from a shell read). The
  score runs on demand at fixed points, not on every push or every PR.
- Rule: no fix for a single search; a change ships only if the hidden
  score goes up.
- The 90 % rule — "90 % before pitching": hidden score ≥ 90 % in every
  language, half of searches under 1 s, plus a friends-and-family round.
- Every engine issue names the score it must move (outcome AC); the
  reviewer runs and reads it.
- The Constructor-bar set stays as a regression suite, not the gate.

**Refinements (2026-09-30, binding).** The grader is Gemini 3.5 Flash-Lite
with a fixed marking rubric, graded relevance 0–3 per product (same-model bias
is accepted; the friends-and-family round is the human check). Budget rules
(2026-10-01, binding): the set is 150 searches, 25 per language, half public
and half hidden; the hidden score runs at six fixed points in M6 (baseline on
the M5 engine; after the find step; after the judge; after chips; the judge
comparison, once per judge; before the delete), triggered on demand, never on
every push or PR; one run is ≈ $0.05 on the M5 engine and ≈ $0.20 with the
judge (estimates, measured on the first runs; the earlier ≈ $0.17 counted the
grader only). The hidden half lives in a GitHub Actions repository secret, not
a repository folder. The first real queries come from the live search log
(every submitted playground search since August), weighted most; model-written
filler fills the rest. Arabic, Russian, French and Spanish scores are marked
model-written until real queries in those languages exist.

### Amendment (2026-08-22) — Colour exclusion, close matches, colourway families (binding; capabilities 2 and 3)

Decided 2026-08-22; recorded here by YOY-114 so the law lives in the PRD
and not only on Linear. Rule (c) still binds capability 3 (filters as
output: what the result set promises); rules (a), (b) and (d) are
superseded in v3:

(a) **A colour exclusion applies to the product's primary (displayed)
colour, not its colourway list.**
Superseded in v3 by §3 Engine v2, "Three kinds of wishes".
Colour is no longer an SQL filter on a model-assigned field: the exclusion
rule survives inside "exclusions are firm", and other colour misses show on
the same item with a label.

(b) **Close matches never violate an explicit exclusion, and relax
constraints one at a time, price first.**
Superseded in v3 by §3 Engine v2, "Three kinds of wishes".
Numbers are never a wall and descriptions are judged rather than filtered,
so there is no ladder of dropped filters left to relax.

(c) **Colourway near-duplicates render as one card per product family,
showing the variant that matches the query colour.** A family sold as
five colourways is one result, not five; the card shows the colourway the
query asked for (or the primary colourway when the query named none).
(Implementation: YOY-117.)

(d) **A negated attribute is a hard exclusion, and "dress for a wedding ≠
wedding dress".**
Superseded in v3 by §3 Engine v2, "Two meanings".
The closed attribute set (attributesInclude = bridal only) and the
14-category / 7-occasion taxonomy it sat in give way to the dossier, the
judge and the two-meanings chip, while the negation survives inside
"exclusions are firm".

## 4. Explicitly out of v1 (Later)
1. Image-input search ("a shoe like this Prada" + photo). Reuses the
   vision infrastructure built in the vision milestone. v3: scheduled in
   milestone 8 once the multi-vector index exists (see §3 Engine v2,
   "Image search").
2. Conversational AI chat mode / sales-assistant widget (Cartally-style).
3. Merchandising suite: pin/boost/demote/hide, bundles, recommendations
   (Boost's territory; consciously skipped).
4. Rigorous attribution: A/B testing vs. native search, multi-touch models.
5. (Removed in v3: all languages ship from day one, with no per-language code; the label templates of §3 Refinement 4 are the one per-language asset — see §3 Engine v2, "Languages".)
6. Door 2 self-serve product: no self-serve generic-store admin, billing portal, or marketing site in v1. REVISED 2026-08-15: a Door 2 MVP (generic feed adapter + embeddable snippet + manual design-partner onboarding) — architecture portability is already binding (see PRD portability constraint and docs/PORTABILITY.md); the playground's store-preload mode (capability 10) must ingest arbitrary public catalogs, not only Shopify stores, making it the first generic-ingestion consumer. REVISED 2026-09-28 (v3): integration shape is a native Shopify app first; a universal script tag for any site; other platforms as real integrations when a paying store asks.
7. Personalization from shopper history.
8. Voice input.
9. Permanent free tier.
10. Any non-fashion vertical positioning (engine may work anywhere;
    marketing, tuning, and demo content are fashion-only).

## 5. User experience
**Shopper flow:** taps the store's search bar → types anything → keyword
previews as they type in the store's normal results layout → submits →
brief loading state, then results grid with filter chips on top and
honest labels on items that miss a wish ("in grey, not black") →
optionally edits chips, taps the two-meanings chip, or types a refinement
→ clicks a product (click recorded) → buys or not. Mobile-first rendering; the widget's presence must feel
native to the store, not like a foreign takeover. Product intent
(sharpened 2026-08-10): Unfiltered intercepts the query and returns
better matches — it does not replace or redesign the store's results
experience. The rendering approach must maximize reuse of the store's
own visual language (theme components/markup where Shopify technically
allows, CSS inheritance where it does not), and a one-size-fits-all
Unfiltered-branded results page is explicitly rejected, as is per-store
manual styling as an ongoing operating model. The exact mechanism (theme
component reuse vs. Section Rendering API vs. deep CSS inheritance, and
what is technically reachable per theme generation) is an open engineering
question requiring a research spike, shipped (Mirror Bar, M3); its
conclusion may adjust this section. Hard bar (2026-08-10): the
shopper-visible footprint may not exceed chips-level additions; the
store's existing design is preserved at a 90–95% minimum. Harming a
store's design is treated as a defect, not a trade-off.

**Merchant flow:** finds app via App Store search (or pastes their store
URL into the playground) → listing → install →
OAuth + billing consent (trial) → guided onboarding: indexing progress →
"try these searches on your catalog" prompts → live storefront widget
enabled → dashboard over the following days → trial-end conversion →
review-ask on first attributed order.

**Screens/pages:** storefront search widget + results overlay; merchant
dashboard (overview, queries, attribution, settings: widget appearance,
language toggle, cap visibility); onboarding wizard; public playground
page; App Store listing.

**Languages & RTL:** shopper-facing widget supports every language from
day one, including proper RTL layout (e.g. Hebrew, Arabic), specced from
day one. Merchant dashboard and onboarding: English only in v1. Playground
accepts queries in any language.

### Amendment (2026-08-16) — The Mirror Bar (binding, platform-agnostic)

The shopper-facing search experience is a complete mirror of the host store's own design — layout, grid, card markup, sizing, spacing, colors, typography, price formatting, page structure and copy furniture (e.g. the results-count heading) — indistinguishable from the store's native results page, on every platform: Shopify (Door 1) and the generic engine (Door 2) alike. The only permitted owned elements are the filter chips and their immediate controls, inherit-first per docs/DESIGN.md. Any mechanism that cannot meet the bar is a fallback, never the shipped default.

## 6. Data & accounts
Stored per store: Shopify OAuth tokens; catalog snapshot; a variants table
(the merchant's own option name/value pairs, per-variant price and stock);
a dossier per product; the multi-vector index (text, and one image vector
per product photo once image search ships); judge answers cached per (normalized search text, candidate product ids, card versions), merchant facts outside the key; query log (query text, latency, cost,
results shown, clicks); attribution events (click→order joins);
plan/usage counters; dashboard aggregates. No shopper accounts and no shopper PII beyond
transient session identifiers for rate-limiting and session attribution;
order data is used only in aggregate for the merchant's own dashboard.
Merchant accounts are Shopify-native (OAuth); no separate password system.
Data deleted on uninstall per Shopify mandatory webhooks (GDPR endpoints
are a Shopify app requirement): uninstall and shop/redact delete every
per-shop record, not sessions only (a "Run alone" requirement, milestone
7). Seed data: one public fashion catalog for the playground.

## 7. Integrations & services
- **Shopify** — platform, catalog API (the public products.json exposes
  every variant with price, option values and stock), webhooks (products,
  orders, uninstall/GDPR), OAuth, Billing API, App Store distribution.
  Partner account is free. Integration shape: native Shopify app first; a
  universal script tag for any site (schema.org offers give price and
  availability, sizes sometimes); other platforms as real integrations
  when a paying store asks.
- **LLM API (dossiers + judge + chip extraction)** — judge per §3 Engine
  v2, "The judge — decision": baseline Gemini 3.5 Flash-Lite, challenger
  Jev (TypeSafe); measured on the hidden score, winner takes page 1, the
  other is fallback, one swap point in code. On total LLM failure, the
  find-stage results serve. The provider mix must include an accuracy-tier
  vision-capable model for ingestion enrichment (capability 14); vision
  runs at ingestion only, never at query time, so it does not affect
  per-search cost.
- **Embeddings API** — same-provider or dedicated embedding model;
  cost negligible (~$0.02–0.13 per 1M tokens range).
- **Vector store** — chosen at spec phase (managed with a free tier that
  covers early scale, e.g. pgvector-on-managed-Postgres-class or
  equivalent; decision is the factory's). Requirement: per-store
  isolation, a multi-vector index, and vector find sub-100 ms at millions
  of products; every storefront scan is bounded.
- **Hosting/DB** — low-ops managed platform, factory's choice. Estimated
  fixed infra ≤ $50/month at launch scale.
- **Email (transactional)** — trial/usage notifications; free tier
  suffices at launch.

## 8. Monetization
Model: subscription via Shopify Billing, priced on monthly submitted
searches (typing previews unlimited and free — honest because they cost
~nothing, and it reads well against Cartally's structure).
Model spend: Gemini first; every spend ceiling is proposed with its expected cost and approved by the founder.

Tiers: **$39** (10K AI searches, catalogs up to 1K products) / **$99**
(50K, up to 5K products) / **$249** (200K, up to 20K products); larger
catalogs are enterprise inquiries. Overage $2 per additional 1,000 AI
searches — re-validated after the M6 judge comparison (RESET §4); hard cap + fallback beyond a store-configurable ceiling. 14-day trial, card required, 1,000 AI-search
trial cap. Anchors: Boost $29–299 (product-count based, free plan),
Cartally $59/$209/$499 (+$1/1K overage), Searchanise from $19. Pricing is
an experiment: v1 measures real cost-per-search, and tier limits/prices
may be revised at version bumps. Tiers are re-validated after the M6
judge comparison and scale with catalog size and search volume.

Unit economics (typical store: 10k products, 20k searches/month; to be
validated by measurement):
- Dossiers ≈ $0.004/product (estimate, revised 2026-10-01) → ~$40 once for 10k
  products; cents/month for changes. Cards are written in priority order with
  raw-text find until a card exists (Refinement 9); a lazy
  full-card-on-first-hit variant stays an option if card cost matters.
- Judge, uncached, short-code answers (estimate): Gemini ≈ $20/month; Jev ≈ $7/month. The answer cache cuts both; the real cache hit rate is measured in M6.
- Hosting share $5–10.
- At $99/month for the typical store above (20k searches): Gemini judge with short codes ≈ 70–75 % margin before cache (estimate: ≈ $20 judge + $5–10 hosting); Jev judge ≈ 85 %. At the tier's full allowance (50k searches) the Gemini judge margin falls to ≈ 45 % before cache — the answer cache hit rate and the judge comparison decide the tier limits. 500-product store ≈ $3–10/month cost.
  200k-product/500k-search store → enterprise tier. Pricing tiers by
  catalog size and search volume. The M6 judge comparison decides on
  quality first, cost second.
- Gross margin target: ≥60% per tier — re-validated after the M6 judge comparison (RESET §4); measured, not assumed.
- Monthly profit scenarios at avg. $60/store revenue and 65% margin:
  pessimistic (30 stores): ~$1.2K; realistic (150 stores): ~$5.9K; good
  (500 stores): ~$19.5K — plus enterprise upsell path outside v1.
- Payment infrastructure: none beyond Shopify Billing (deliberate).

### Cost & pricing operations
Tier limits and prices are revised only against measured evidence, at PRD
version bumps. The machinery that makes revision evidence-based ships in
v1:
1. **Judge comparison, quality first.** The judge (Gemini baseline vs Jev
   challenger) is chosen on the hidden score first and cost second; the
   loser is the fallback behind one swap point. Any engine change must
   raise the hidden score before shipping.
2. **Answer caching.** Judge answers are cached per (normalized search text, candidate product ids, card versions); merchant facts are outside the key, so stock and price changes do not evict answers. The real cache hit rate is measured in M6.
3. **Required internal metrics from day one:** per-store cap-utilization
   distribution, cache hit rate, blended cost per 1K per tier, and the
   judged-vs-fallback CTR delta per store (the guardrail that cost tuning never
   degrades result quality).
4. **Cap placement is an upsell mechanism, not a usage limit.** Overage
   ($2 per 1K; judge cost per the unit economics above) means heavy users
   are profitable; caps are positioned so growing stores hit them
   naturally, verified against the utilization distribution at each
   revision.

## 9. Validation & go-to-market
Channel research findings baked in: ~70% of app discovery starts with App
Store search; ranking is driven by keyword relevance, review count and
velocity, and quality signals ("Built for Shopify" badge confers a
confirmed ranking boost); the stage playbook is niche keywords + early
reviews (0–100 installs), then listing depth + review velocity + content
(100–1,000).

Plan, in order:
1. **ASO on niche keywords** (v1 deliverable, capability 13): own "AI
   search fashion", "natural language search", Hebrew terms with zero
   competition; concede "search" to Boost.
2. **Playground-powered cold outreach**: factory builds tooling to
   identify fashion Shopify storefronts and generate per-store playground
   links (their own catalog, pre-loaded); the user sends short personal
   emails linking to them. This is the only channel that doesn't wait for
   rankings, and the demo IS the pitch.
3. **Review engine** (capability 9) to compound ranking.
4. **Paid accelerant**: Shopify Search Ads on niche keywords, ~$200–500/
   month, only after trial→paid conversion data exists.

First 3 customers: expected from channels 1–2 within the first 60 days
post-listing. Realistic organic expectation: 10–30 trials/month early,
20–40% trial→paid (carded trials), ~100 paying stores in 9–15 months
organically, faster with channels 2–4 compounding.

Before spending on growth: trial→paid ≥25% and measured gross margin ≥60%.

**Decision checkpoint:** if <30 paying stores by 6 months post-launch
despite a working product, pivot to Door 2 early — direct outreach to
Israeli mid-market fashion retail using existing stores as proof; the
catalog-agnostic architecture and playground were kept for exactly this.

## 10. Success criteria
1. ≥100 installs and ≥30 paying stores within 6 months of App Store
   listing going live.
2. Trial→paid conversion ≥25%.
3. Measured blended AI cost ≤ $2 per 1,000 AI searches — re-validated
   after the M6 judge comparison (RESET §4); gross margin ≥60%.
4. Across active stores: judged-search click-through rate exceeds the
   store's previous search CTR on the same stores (the engine visibly
   outperforms).
5. ≥10 Shopify reviews at ≥4.5 average within 6 months.
6. Before pitching and before Shopify submission: hidden score ≥ 90 % in
   every language, half of searches under 1 s, plus a friends-and-family
   round (§3 Quality gate).
All measurable from our own query/attribution logs and Shopify admin — no
external analytics platform required.

## 11. Risks & open questions
- **Crowded category / discoverability**: 100+ search apps; ranking from
  zero is slow. Mitigated by niche keywords, outreach channel, review
  engine; checkpoint at 6 months (section 9).
- **Result-quality risk**: if AI results are mediocre on real messy
  catalogs (thin product descriptions are common), the pitch collapses.
  Mitigated by dossiers at load time (§3 Engine v2) — factory decides technique; PRD requires that quality on
  sparse catalogs be tested in milestone 2 against a deliberately
  low-quality test catalog. The strategic answer to sparse product text
  is vision enrichment (capability 14, its own milestone): images carry
  the attributes the text omits. v3: the hidden human-style score is the
  release gate (§3 Quality gate).
- **Cost drift**: heavy AI usage at $249-tier scale can squeeze margin.
  Mitigated by required cost measurement + caps.
- **Platform dependence**: Shopify policy/API changes; accepted for v1.
- **Incumbent response**: Boost adding a true free-text layer would
  compress our window. No mitigation other than speed and fashion depth.
- **Shopify Search & Discovery**: Shopify's free app already offers
  meaning-based search on the Shopify and Advanced plans, in "multiple
  languages", with no documented constraint handling (negation, price,
  size). Unfiltered positions on shop-assistant behaviour with honest
  labels, chips, any language, every plan, attributed revenue.
- **Deferred questions**: exact model/provider mix (spec phase, milestone
  2); final tier prices (revisit after 60 days of margin data).

## 12. Human checklist
- [ ] Create Shopify Partner account (blocks milestone 1 testing on a dev
      store — do first).
- [ ] Create LLM provider account(s) + API keys, set billing limits
      (blocks milestone 2).
- [ ] Create hosting/DB/vector-store accounts per factory's spec + payment
      method (blocks milestone 2 deploy).
- [ ] Register a domain for the product + playground (blocks milestone 4;
      buy early, it's cheap).
- [ ] Transactional email service account (blocks milestone 7).
- [ ] Shopify App Store listing assets you must approve: app name check,
      final copy, screenshots, demo video (blocks milestone 8 and the
      90 % gate before submission).
- [ ] App Store review submission + responding to Shopify's review
      feedback (days-to-weeks; start as soon as milestone 8 is done and the
      90 % gate is met).
- [ ] Send the cold-outreach emails from your own address once tooling
      hands you the list + links (ongoing, post-launch).
- [ ] Approve pricing tiers as configured in Shopify Billing before
      listing goes live.

## 13. Milestone sketch
Milestones 1–5 (skeleton, ingestion + AI pipeline core, classic search +
widget, playground, vision enrichment + cost routing) are shipped as
sketched in v2. From v3 the plan is:

6. **Engine v2** — one spec session, one chain (~10–12 issues): the
   score; variants table + dossiers + multi-vector index; find-then-judge
   behind the current API; shop-assistant labels; server-side pages and counts (page 2 judged when the shopper nears it, never pre-judged); judge comparison (Gemini vs Jev); delete the old switch and
   ladder; copy pass on the site (tiers) once the PRD fixes them.
7. **Run alone** — requirements:
   - Automatic re-analysis on product change: webhook sync re-enriches
     and re-embeds changed products; retrieval checks content freshness
     so edited products are never served with stale vectors or
     attributes; webhook-created products get their vector without a
     manual ingest.
   - A real health check that touches the database and search, not the
     engine stub only.
   - Uninstall data deletion: shop/redact and app/uninstalled delete every
     per-shop record (catalog products, enrichments, embeddings, images,
     search events, click events, AI calls), not sessions only.
   - Bounded scans: every storefront vector scan carries a limit.
   - Kill switch; billing; dashboard/attribution.
8. **Surfaces and onboarding** — image search, thumbs up/down on the
   playground, paste-URL onboarding, listing assets, GDPR webhooks.

Shopify submission after the 90 % gate. Revenue is a Q1 2027 goal.

Post-M8 backlog: review-ask trigger, abuse limits, Built-for-Shopify
compliance pass, outreach tooling, Door 2 MVP.
