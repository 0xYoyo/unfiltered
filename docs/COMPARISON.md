# Unfiltered vs. the incumbent search-bar-plus-filters

Raw material for App Store listing copy and outreach emails. Shipped = M1–M3 state.

| Capability | Old method (stock search + filter sidebar) | Unfiltered — shipped | Planned |
|---|---|---|---|
| Keyword lookup, typos | Good (prefix, synonyms) | Trigram + typo-tolerant, title-dominant; parity floor enforced (YOY-67) | Parity floor per PRD §3 |
| Live results per keystroke | Yes | Decided: classic streams live per keystroke; AI on submit (YOY-68) | — |
| Hebrew typo tolerance | Weak to none | Works (any-script trigram) | — |
| Natural language ("elegant, hides my arms, not black") | Nothing — shopper must translate intent into filter clicks | Full intent extraction → constraints + semantic match | Quality ↑ via M5 vision |
| Cross-language (HE query, EN catalog) | Zero results, always | Works via AI route (YOY-67 closing the short-query hole) | Mirror direction + more languages post-launch |
| Filters | Input the shopper must operate | Output — inferred, shown as removable chips | Truthful-chips labeling (YOY-67) |
| Negation / price phrasing ("not black, under 400") | Impossible in a search bar | Hard constraints, code-enforced | — |
| Follow-ups ("same but cheaper") | Start over from scratch | Deterministic refinement merge, comparative enforcement | — |
| Zero-hit state | Dead "no results" | Chips kept + close-match rescue, cross-language vector fallback | Escalate-on-empty (YOY-67) |
| Understanding thin catalogs | Only matches text that exists | LLM attribute enrichment at ingestion | M5 vision: image-derived attributes |
| Merchant proof | Basically none | Query log, click beacon, cost metering plumbed | M6: attributed-orders dashboard (hero metric) |
| Latency on simple queries | Instant | Instant (classic, <150ms, no LLM) | — |
| Latency on AI queries | n/a | p50 ~0.9 s server-side (EN 908 ms, HE 976 ms); p95 EN 3.4 s, HE 8.0 s — the HE tail is an upstream intent-model hang rate, bounded at 8 s (docs/LATENCY.md, 2026-08-26) | YOY-64 tail: the HE hang rate |
| Demo without installing | Impossible | — | M4 playground, per-store preloaded catalogs |
| Economics | Flat app fee | Metered AI, classic free, blended $1.12/1k measured | M5 cost routing |
