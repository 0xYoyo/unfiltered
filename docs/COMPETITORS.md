# Competitive Strategy & Market Map

Source: deep competitive teardown, 2026-08-15 (full report in project archive). Distilled to what binds decisions. Owner: founder. Amend via PR only.

## The moat (binding hierarchy)

The moat is measured superiority of the core loop, for both sides of the marketplace: the shopper finds what they meant (accuracy, speed, seamlessness — never a chatbot) and the merchant sees money (attributed revenue, honest pricing, painless integration, zero-maintenance). Every roadmap and spec decision is ranked by its contribution to that loop.

Features are NOT the moat. They are proof surfaces, ranked by how fast they make the moat visible:
- Playground with per-store catalog preload = quality visible BEFORE install (a demonstration, not a claim). Primary greenfield weapon: most fashion stores have never heard of any competitor; the demo sells into a vacuum.
- Attribution-first dashboard/onboarding = quality visible AFTER install (merchant watches the money line).
- Filter chips = the shopper's window into what the AI understood; makes AI answers correctable instead of black-box.

Result quality must stay a NUMBER, not a mood: eval suite is canon; benchmark against the hardest public bar (Constructor's "3 levels of natural language search": negations, price caps, "dress for a wedding ≠ wedding dress") on fashion query sets; publishable when strong. A market where everyone claims AI and few deliver it rewards whoever can prove it.

## Market read

Fragmented early market, not a locked one. The incumbent's engine is a generation old; the modern entrants are unproven. Strategy: go THROUGH them on core-loop quality, not around them into niches. The structural headwind is not product — it is that quality is invisible at install time while review counts are visible (Boost ~1,568 reviews). Proof surfaces exist to collapse that gap. Greenfield reality: countless fashion stores have never been approached by anyone; outreach sells without comparison shopping.

## Tier 1 — Shopify apps (steal / attack per vendor)

- Boost AI Search & Discovery — incumbent, ~1,568 reviews, 4.7★. Keyword+semantic under AI branding; TURBO replaces theme templates with Boost-owned lookalike Liquid (per-theme maintenance); GMV-based pricing (~$29 Launch, ~$299 Convert, $2/extra $1K GMV). STEAL: revenue-impact analytics depth. ATTACK: theme-swap/campaign friction, old engine, GMV metering.
- Cartally — the thesis twin: classic→AI→conversational ladder, search-count pricing ($59/20K AI searches, $209/180K; overages $1/1K), 5-min install. 1 review, EN+PL only, unproven at scale. STEAL: pricing-model validation. WATCH: closest architectural competitor; if it adds fashion depth or serious languages, accelerate.
  - Findings (2026-08-22, YOY-114): Cartally runs three latency tiers — ~10 ms keyword, ~300 ms "advanced", and an LLM tier measured in seconds. That is independent convergence on our confidence routing (lite-first, escalate on low confidence — YOY-116) and is treated as validation of the ladder, not as a threat to it. Our AI bar — p50 < 2 s, p95 < 3.5 s server-side, measured per docs/LATENCY.md — beats the field's LLM tier, which is the tier a shopper actually waits on. Weaknesses to attack: an injected widget UI (we mirror the theme — the Mirror Bar); a chatbot pivot (we stay in the bar); generic multilingual with no fashion depth; no vision story.
- Fast Simon — feature breadth, visual search, fashion clients, SSR of its own widget; session-based pricing (free ≤100 sessions, from ~$39.99). ATTACK: session-metering cost creep, widget-not-native.
- Searchanise — value player ($19–49, priced per product count), pure JS widget ("no liquid template"), no NL depth. ATTACK: can't-customize-cards ceiling, translation gaps.
- Doofinder — 15K stores, loud NL marketing, visual AI tagging; request-based metering with documented bill shock (public vendor reply: "we undeniably screwed up"). ATTACK: billing distrust, support inconsistency.
- Klevu — real NLP, $449–649/mo, enterprise-leaning (Athos). STEAL: the alternate-template native-card rendering method (documented, production-proven; adopted into YOY-70 spike as Variant A). ATTACK: price floor, long-tail NLP misses, shallow analytics.
- Rising LLM-natives (Shoply, XTAL, Nosto down-market): raising the NL bar; mostly chatbot-first — our seamless-in-the-search-bar stance is the counter.

## Tier 2 — Enterprise (Door 2 horizon)

Algolia (NeuralSearch hybrid, paywalled to Elevate annual contracts), Constructor (the NL gold standard; revenue-optimization framing), Bloomreach/Coveo (top of market, data moats), Nosto/Searchspring (mid-market fashion-heavy). Rule: never fight them on breadth; the wedge into mid-market is the same core loop plus language/fashion depth at sane pricing. Their pricing complexity and enterprise gating are the SMB opening.

## Threat ranking

Shopify: 1) Boost (distribution) 2) Cartally (same thesis) 3) Fast Simon (breadth) 4) LLM-native newcomers. Enterprise: Constructor and Algolia define the technical ceiling.

## Strategic law (binding, 2026-08-22)

Do not chase breadth. Algolia, Klevu, and Searchspring own feature breadth and will always list more; a breadth race is lost before it starts and drags the core loop. The wedge is three things, in order: theme-mirroring results (native when possible, functional always); vision enrichment for attribute-starved catalogs (the differentiator on every plan — PRD capability 14); honest attribution (the merchant's money line, never inflated). Hebrew stays a local-sales convenience — never a headline, never a moat claim (see Positioning notes). A roadmap item that serves none of the three is deferred by default.

## Positioning notes (binding)

- Hebrew: local-sales convenience for Israeli leads, NEVER a headline or moat claim. Multilingual is a later chapter after the core loop is proven.
- Pricing posture: sensible-best, never the cheap option; premium is the eventual position. Search-count metering stays (validated by Cartally; every alternative meter — GMV, sessions, requests — has documented bill-shock complaints we cite in positioning).
- Rendering claim when spike proves out: "native when possible, functional always" — theme-native results with automatic own-widget fallback. No SMB competitor markets this.
- Quality bar additions from incumbent complaints: survive theme updates/swaps without breakage; no metering surprises; card-level customization never a ceiling.
