# Unfiltered — PRD
Version: 2 · Date: 2026-08-07
v2: vision enrichment promoted to a core capability and its own milestone; catalog-size caps added to tiers; cost & pricing operations codified. Decisions from the 2026-08-07 planning session, informed by measured M2 economics.

Product type: B2B web SaaS, delivered as a Shopify app (self-serve). The
engine is catalog-agnostic by design (feed + JS snippet) to keep a future
direct-sales door open, but v1 sells only through the Shopify App Store.

## 1. One-liner
Unfiltered replaces rigid filter-based product search on fashion Shopify
stores with free-text search that understands how humans actually describe
what they want ("elegant summer wedding dress, not black, under ₪400, hides
my belly") — in English and Hebrew — and proves its value to the merchant in
attributed orders.

## 2. Problem & audience
Shoppers on large-catalog fashion stores can't express what they want
through fixed filters. Research: ~69% of e-commerce visitors use the search
bar immediately, yet ~80% abandon due to unsatisfactory search results.
Incumbent fixes are either enterprise-gated (Algolia NeuralSearch, Elevate
tier only), filter-suite-first with AI sprinkled on (Boost, 1,900+ reviews,
the category incumbent), or young and unproven (Cartally, launched Nov 2025).
Nobody owns fashion specifically; nobody treats Hebrew/multilingual
seriously; nobody leads with revenue attribution.

Audience: fashion/apparel Shopify stores with large catalogs (roughly 500+
products), where scrolling and filters genuinely break down. Buyer: the
store owner/manager. End user: their shoppers. Why now: small-model LLM
pricing (~$0.10–0.40 per 1M tokens and falling ~80%/year) makes per-search
AI economically viable at SMB price points for the first time.

> **Positioning note (2026-08-15, binding):** The moat is measured superiority of the core search loop for both shopper and merchant — accuracy, speed, seamlessness, attributed revenue, honest pricing, painless integration. Features (chips, playground, attribution-first onboarding) are proof surfaces that make that superiority visible, not the moat itself; they are prioritized by visibility speed. Hebrew support is a local-sales convenience, never a headline. Pricing posture: sensible-best, not cheapest. See docs/COMPETITORS.md.

## 3. v1 scope
Numbered capabilities, each observable behavior:

1. **Hybrid search ladder, one search bar.** The app replaces/augments the
   store's search box. Simple queries ("nike air max 90", typos included)
   are answered by instant classic keyword search (target: results render
   <150ms, no LLM call). Queries classified as natural-language ("something
   for a beach wedding that hides my arms") escalate automatically to the
   AI pipeline (target: results <2s). The shopper never chooses a mode.
2. **AI understanding pipeline.** An LLM extracts structured intent from
   the free-text query (category, price cap, color inclusions/exclusions,
   occasion, fit/soft attributes); hard constraints (price, size,
   availability) are applied as database filters; soft attributes are
   matched via embedding similarity over the catalog. Works for English
   and Hebrew queries, including mixed-language queries.
3. **Filters as output, not input.** AI results arrive with the implied
   filters visibly applied as removable chips (e.g. "Dresses × · Under
   ₪400 × · Not black ×"). The shopper can remove or adjust chips and
   results update using the store's normal filtering.
4. **Follow-up refinement in the bar.** After a result set, typing a
   refinement ("same but cheaper", "בלי שרוולים") modifies the previous
   intent instead of starting over. Single-session memory only; this is
   not a chatbot.
5. **Catalog ingestion & sync.** On install, the app ingests the store's
   Shopify catalog (titles, descriptions, tags, attributes, price, stock,
   images' alt text), embeds it, and stays in sync with product changes
   (target: updates reflected within 15 minutes). One-time embedding cost
   ~$1–5 per store at typical catalog sizes.
6. **Instant fallback.** If the AI pipeline errors, times out, or a store
   exceeds caps, the search bar silently serves classic search results.
   The shopper never sees an error state caused by us.
7. **Merchant dashboard.** Shows: total searches (split classic/AI), top
   queries, zero-results queries rescued by AI (queries where classic
   search found nothing but AI returned results), click-through rate on
   our results, and the hero metric: search-attributed orders (shopper
   clicked one of our results → purchased that product within the session
   or 24h, via Shopify order webhooks) with currency value.
8. **Onboarding engineered to an activation milestone.** Install →
   catalog indexed → merchant runs one successful AI search on their own
   products, in under 10 minutes, guided. First-session searches use the
   best (most expensive) model tier so the merchant's own test queries
   feel like magic; routing economics apply afterwards.
9. **Review-ask trigger.** The dashboard requests a Shopify review exactly
   once, at the moment the merchant first views a nonzero
   search-attributed-orders figure.
10. **Public demo playground.** A public web page with a real ingested
    fashion catalog where anyone can type free-text queries and see
    results — no install, no login. Supports a mode where a specific
    store's public catalog can be pre-loaded via URL parameter (for
    outreach: "here is YOUR catalog answering human questions").
11. **Cost & abuse controls.** Per-IP/session rate limits on AI searches;
    identical-query caching; per-store monthly AI-search caps by plan with
    automatic fallback to classic search when exceeded; a global per-store
    LLM spend ceiling on our side. Real cost-per-search is measured and
    visible in our internal admin from day one.
12. **Billing.** Shopify-native billing: 14-day free trial (card required,
    capped at 1,000 AI searches), then tiers per section 8.
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
    worn by models in the photos. Vision output merges into the same
    enrichment schema (category, colors, occasions, fit, styleTags) plus
    vision-only attributes (coverage — e.g. sleeve length, neckline,
    garment length —, pattern, material appearance); text-derived values
    win conflicts on factual fields, vision fills gaps. Changed
    enrichment re-embeds automatically via the composed-text freshness
    hash. This capability is standard on every plan — it is the
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

**Self-removal kill switch (added 2026-08-10).** Capability 6 covers
AI-call failures; this covers genuine application bugs. If Unfiltered
itself is broken in a way that impairs a store's ability to search at
all, the widget must be able to fully disable itself — per store,
remotely, and automatically on repeated hard failures — restoring the
store's native search untouched, without a theme edit or reinstall.
Merchants never inherit our downtime. Mechanism specced with M6's
operational work.

**Interaction model (decided 2026-08-10, implemented in YOY-68,
pre-M4).** While the shopper types, the bar behaves like a normal search
bar: live, debounced, classic-only results per keystroke — free and
instant. The full Unfiltered pipeline (classification, AI understanding,
chips, refinement, rescue) fires only on explicit submit (Enter or the
magnifier). Keystroke previews consume no AI budget and are not logged
as searches.

**Portability constraint (binding, 2026-08-13):** v1 is built
Shopify-first, but every shopper-facing mechanism must state its
generic-store (Door 2) analog at design time. Shopify-specific code is an
adapter around a generic mechanism, never the mechanism itself. A design
whose generic analog cannot be stated is rejected at spec time. The
pre-Door-2 adapter-boundary audit is tracked as YOY-81.

### Amendment (2026-08-22) — Colour exclusion, close matches, colourway families (binding; capabilities 2 and 3)

Decided 2026-08-22; recorded here by YOY-114 so the law lives in the PRD
and not only on Linear. Three rules bind capability 2 (AI understanding:
how a constraint is applied) and capability 3 (filters as output: what the
chips and the result set promise):

(a) **A colour exclusion applies to the product's primary (displayed)
colour, not its colourway list.** "Not black" excludes products whose
primary colour is black. A pink dress that also comes in black is a
CORRECT answer to "not black": the shopper is looking at a pink dress.
Filtering on the colourway list would silently remove most of a catalog
whose every family ships a black variant. (Implementation: YOY-110.)

(b) **Close matches never violate an explicit exclusion, and relax
constraints one at a time, price first.** The zero-hit rescue may loosen
what the shopper asked for, but never by returning what they excluded —
a "not black" query never rescues with a black product. Relaxation is
stepwise, and each step says which constraint it dropped: price cap
first, then the remaining hard constraints one by one. A close-match set
that relaxes two things at once, or relaxes silently, is a defect.
(Implementation: YOY-111.)

(c) **Colourway near-duplicates render as one card per product family,
showing the variant that matches the query colour.** A family sold as
five colourways is one result, not five; the card shows the colourway the
query asked for (or the primary colourway when the query named none).
(Implementation: YOY-117.)

(d) **A negated attribute is a hard exclusion, and "dress for a wedding ≠
wedding dress".** (Added 2026-08-27 by YOY-133.) "No sleeves", "not
wool", "not leather", "בלי שרוולים", "לא מצמר" exclude every product
whose evidence — its title, tags, description, or enrichment — carries
the negated attribute, in any language the catalog is written in; a
product with no evidence of the attribute stays (unknown passes), and a
product whose only mention is itself a negation ("ללא צמר", "wool-free")
stays too. The negation is a filter, never a ranking preference, it shows
as a removable chip ("Not wool ×") like a colour exclusion, and no
close-match rescue ever violates it. "Dress for a wedding" is the guest's
query — dresses for the occasion, bridal gowns excluded — while "wedding
dress" is the bridal gown itself; the engine keeps the two apart with a
closed set of category-like attributes (today: bridal) that an intent may
require or exclude. A purpose phrase — "sneakers for running", "שמלה
לחתונה" — is natural-language intent by definition and always takes the
AI path, deterministically, because keyword search cannot read purpose.
Measured on the Constructor-bar set: 19 mustNot leaks → 0, 30 of 30
goldens clean. (Implementation: YOY-133.)

## 4. Explicitly out of v1 (Later)
1. Image-input search ("a shoe like this Prada" + photo). Reuses the
   vision infrastructure built in the vision milestone.
2. Conversational AI chat mode / sales-assistant widget (Cartally-style).
3. Merchandising suite: pin/boost/demote/hide, bundles, recommendations
   (Boost's territory; consciously skipped).
4. Rigorous attribution: A/B testing vs. native search, multi-touch models.
5. Languages beyond EN+HE (architecture is language-agnostic; adding
   Spanish/French/Arabic/Chinese is config-and-QA later).
6. Door 2 self-serve product: no self-serve generic-store admin, billing portal, or marketing site in v1. REVISED 2026-08-15: a Door 2 MVP (generic feed adapter + embeddable snippet + manual design-partner onboarding) is scheduled as milestone 8, run during the App Store review-wait window — architecture portability is already binding (see PRD portability constraint and docs/PORTABILITY.md); the playground's store-preload mode (capability 10) must ingest arbitrary public catalogs, not only Shopify stores, making it the first generic-ingestion consumer.
7. Personalization from shopper history.
8. Voice input.
9. Permanent free tier.
10. Any non-fashion vertical positioning (engine may work anywhere;
    marketing, tuning, and demo content are fashion-only).

## 5. User experience
**Shopper flow:** taps the store's search bar → types anything → simple
query: instant classic results in the store's normal results layout → NL
query: brief loading state, then results grid with filter chips on top →
optionally edits chips or types a refinement → clicks a product (click
recorded) → buys or not. Mobile-first rendering; the widget's presence must feel
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
question requiring a research spike, specced no later than M6; its
conclusion may adjust this section. Hard bar (2026-08-10): the
shopper-visible footprint may not exceed chips-level additions; the
store's existing design is preserved at a 90–95% minimum. Harming a
store's design is treated as a defect, not a trade-off.

**Merchant flow:** finds app via App Store search → listing → install →
OAuth + billing consent (trial) → guided onboarding: indexing progress →
"try these searches on your catalog" prompts → live storefront widget
enabled → dashboard over the following days → trial-end conversion →
review-ask on first attributed order.

**Screens/pages:** storefront search widget + results overlay; merchant
dashboard (overview, queries, attribution, settings: widget appearance,
language toggle, cap visibility); onboarding wizard; public playground
page; App Store listing.

**Languages & RTL:** shopper-facing widget fully supports EN and HE
including proper RTL layout, specced from day one. Merchant dashboard and
onboarding: English only in v1. Playground supports both query languages.

### Amendment (2026-08-16) — The Mirror Bar (binding, platform-agnostic)

The shopper-facing search experience is a complete mirror of the host store's own design — layout, grid, card markup, sizing, spacing, colors, typography, price formatting, page structure and copy furniture (e.g. the results-count heading) — indistinguishable from the store's native results page, on every platform: Shopify (Door 1) and the generic engine (Door 2) alike. The only permitted owned elements are the filter chips and their immediate controls, inherit-first per docs/DESIGN.md. Any mechanism that cannot meet the bar is a fallback, never the shipped default.

## 6. Data & accounts
Stored per store: Shopify OAuth tokens; catalog snapshot + embeddings;
query log (query text, classification, latency, cost, results shown,
clicks); attribution events (click→order joins); plan/usage counters;
dashboard aggregates. No shopper accounts and no shopper PII beyond
transient session identifiers for rate-limiting and session attribution;
order data is used only in aggregate for the merchant's own dashboard.
Merchant accounts are Shopify-native (OAuth); no separate password system.
Data deleted on uninstall per Shopify mandatory webhooks (GDPR endpoints
are a Shopify app requirement). Seed data: one public fashion catalog for
the playground.

## 7. Integrations & services
- **Shopify** — platform, catalog API, webhooks (products, orders,
  uninstall/GDPR), OAuth, Billing API, App Store distribution. Partner
  account is free. No fallback; the product is a Shopify app.
- **LLM API (intent extraction + query classification)** — provider/model
  chosen at spec phase from the nano/flash tier (current market
  ~$0.10–0.40 per 1M tokens); requirement: blended cost ≤ $2 per 1,000 AI
  searches, with routing (cheap model for most queries, better model for
  hard ones and for first-session magic). Fallback: second provider
  configured; on total LLM failure, classic search serves. The provider
  mix must include an accuracy-tier vision-capable model for ingestion
  enrichment (capability 14); vision runs at ingestion only, never at
  query time, so it does not affect per-search cost.
- **Embeddings API** — same-provider or dedicated embedding model;
  cost negligible (~$0.02–0.13 per 1M tokens range).
- **Vector store** — chosen at spec phase (managed with a free tier that
  covers early scale, e.g. pgvector-on-managed-Postgres-class or
  equivalent; decision is the factory's). Requirement: per-store
  isolation and sub-300ms similarity lookups.
- **Hosting/DB** — low-ops managed platform, factory's choice. Estimated
  fixed infra ≤ $50/month at launch scale.
- **Email (transactional)** — trial/usage notifications; free tier
  suffices at launch.

## 8. Monetization
Model: subscription via Shopify Billing, priced on monthly AI searches
(classic searches unlimited and free — honest because they cost ~nothing,
and it reads well against Cartally's structure).

Tiers: **$39** (10K AI searches, catalogs up to 1K products) / **$99**
(50K, up to 5K products) / **$249** (200K, up to 20K products); larger
catalogs are enterprise inquiries. Overage $2 per additional 1,000 AI
searches; hard cap + fallback beyond a store-configurable ceiling. 14-day trial, card required, 1,000 AI-search
trial cap. Anchors: Boost $29–299 (product-count based, free plan),
Cartally $59/$209/$499 (+$1/1K overage), Searchanise from $19. Pricing is
an experiment: v1 measures real cost-per-search, and tier limits/prices
may be revised at version bumps.

Unit economics (stated assumptions, to be validated by measurement):
- Cost per AI search: $0.0005–0.002 blended with routing/caching
  (~$0.5–2 per 1,000). Classic search ≈ $0.
  *Measured (YOY-116, 2026-08-26, eval harness on the routed blend at real
  prices — `gemini-3.6-flash` $0.75 / $3.75 per 1M tokens through
  2026-12-31):* blended **$0.52 per 1,000 AI searches** on the eval blend (lite-first intent extraction with class/confidence escalation to the accuracy tier: escalation rate 56% of AI searches, 11% of follow-ups; refinement follow-ups $0.60 per 1,000; one-time indexing $0.013 for the 61-product fixture catalog). The M4 live figure of $0.98 per 1,000 (YOY-95 step 8) was metered at the 2027 accuracy-tier price and reads $0.49 at the price in force; both sit inside the stated $0.5–2 band. The
  target for the intent tier is ≤ $0.60 per 1,000 AI searches, asserted by
  the harness.
- Typical store volumes: ~10–30% of searches classify as AI-tier.
  A store on the $99 plan using 50K AI searches costs us ~$25–100;
  routing discipline targets the low end. One-time embedding: $1–5/store.
- Gross margin target: ≥60% per tier; measured, not assumed.
- Monthly profit scenarios at avg. $60/store revenue and 65% margin:
  pessimistic (30 stores): ~$1.2K; realistic (150 stores): ~$5.9K; good
  (500 stores): ~$19.5K — plus enterprise upsell path outside v1.
- Payment infrastructure: none beyond Shopify Billing (deliberate).

### Cost & pricing operations
Tier limits and prices are revised only against measured evidence, at PRD
version bumps. The machinery that makes revision evidence-based ships in
v1:
1. **Confidence-based routing (lite-first).** Intent extraction runs on the
   lite tier first and escalates the same query to the accuracy tier on low
   confidence or known-weak query classes (e.g. occasion-bearing queries,
   per eval data). Target blended cost ≤ $0.60 per 1,000 AI searches. Any
   routing change must pass the eval quality bar before shipping.
2. **Semantic caching.** Beyond identical-query caching, intent results are
   cached keyed on query-embedding similarity above a threshold, so
   paraphrases of recent queries cost $0.
3. **Required internal metrics from day one:** per-store cap-utilization
   distribution, cache hit rate, blended cost per 1K per tier, and the
   AI-vs-classic CTR delta per store (the guardrail that cost tuning never
   degrades result quality).
4. **Cap placement is an upsell mechanism, not a usage limit.** Overage
   ($2 per 1K against ~$0.60–1.10 cost) means heavy users are profitable;
   caps are positioned so growing stores hit them naturally, verified
   against the utilization distribution at each revision.

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
3. Measured blended AI cost ≤ $2 per 1,000 AI searches; gross margin ≥60%.
4. Across active stores: AI-search click-through rate exceeds classic-
   search CTR on the same stores (the engine visibly outperforms).
5. ≥10 Shopify reviews at ≥4.5 average within 6 months.
All measurable from our own query/attribution logs and Shopify admin — no
external analytics platform required.

## 11. Risks & open questions
- **Crowded category / discoverability**: 100+ search apps; ranking from
  zero is slow. Mitigated by niche keywords, outreach channel, review
  engine; checkpoint at 6 months (section 9).
- **Result-quality risk**: if AI results are mediocre on real messy
  catalogs (thin product descriptions are common), the pitch collapses.
  Mitigated by enrichment at ingestion (LLM-generated attribute tags per
  product) — factory decides technique; PRD requires that quality on
  sparse catalogs be tested in milestone 2 against a deliberately
  low-quality test catalog. The strategic answer to sparse product text
  is vision enrichment (capability 14, its own milestone): images carry
  the attributes the text omits.
- **Cost drift**: heavy AI usage at $249-tier scale can squeeze margin if
  routing is lazy. Mitigated by required cost measurement + caps.
- **Platform dependence**: Shopify policy/API changes; accepted for v1.
- **Incumbent response**: Boost adding a true free-text layer would
  compress our window. No mitigation other than speed and fashion depth.
- **Deferred questions**: exact model/provider mix (spec phase, milestone
  2); whether Hebrew demand materializes (review at 6-month checkpoint);
  final tier prices (revisit after 60 days of margin data).

## 12. Human checklist
- [ ] Create Shopify Partner account (blocks milestone 1 testing on a dev
      store — do first).
- [ ] Create LLM provider account(s) + API keys, set billing limits
      (blocks milestone 2).
- [ ] Create hosting/DB/vector-store accounts per factory's spec + payment
      method (blocks milestone 2 deploy).
- [ ] Register a domain for the product + playground (blocks milestone 4;
      buy early, it's cheap).
- [ ] Transactional email service account (blocks milestone 6).
- [ ] Shopify App Store listing assets you must approve: app name check,
      final copy, screenshots, demo video (blocks milestone 7 submission).
- [ ] App Store review submission + responding to Shopify's review
      feedback (days-to-weeks; start as soon as milestone 7 is ready).
- [ ] Send the cold-outreach emails from your own address once tooling
      hands you the list + links (ongoing, post-launch).
- [ ] Approve pricing tiers as configured in Shopify Billing before
      listing goes live.

## 13. Milestone sketch
1. **Skeleton, test suite, CI on pull_request** — repo, app scaffold with
   Shopify OAuth against a dev store, green checks. (~5–8 issues)
2. **Catalog ingestion + AI pipeline core** — ingest/sync/embed a catalog;
   query classification; intent extraction; vector + filter retrieval;
   cost metering; sparse-catalog quality test. (~10–14 issues)
3. **Classic search + hybrid ladder + storefront widget** — instant
   keyword/typo search, escalation logic, results UI with filter chips,
   refinement, fallback, EN+HE+RTL. (~10–14 issues)
4. **Playground** — public page, seeded catalog, store-catalog-preload
   mode. (~4–6 issues)
5. **Vision enrichment + cost routing** — vision analysis at ingestion
   (all images, cap 4, accuracy tier, anchored anti-contamination prompt),
   merge into enrichment schema + vision-only coverage attributes,
   image-hash-keyed re-analysis, automatic re-embedding; contamination
   test cases added to the eval harness (e.g. a hoodie shot with visible
   sneakers and jewelry must not emit footwear/jewelry attributes);
   confidence-based lite-first intent routing with accuracy-tier
   escalation, eval bar re-verified on the routed blend; measured
   vision cost per image recorded. (~6–10 issues)
6. **Merchant dashboard + attribution + billing** — usage/query/CTR
   views, order attribution via webhooks, review-ask trigger, Shopify
   Billing tiers/trial/caps, abuse limits. (~10–14 issues)
7. **Onboarding + listing + launch hardening** — activation-milestone
   onboarding flow, first-session best-model behavior, Built-for-Shopify
   compliance pass, listing assets, GDPR webhooks, submission. (~8–12
   issues)
8. **Outreach tooling + Door 2 MVP** (post-submission, parallel with App Store review wait) — fashion-store identification + per-store playground link generation for BOTH Shopify and non-Shopify stores; generic feed adapter + embeddable snippet + manual onboarding path for first non-Shopify design partners (Israeli fashion brands as warm leads). (~6–10 issues)
