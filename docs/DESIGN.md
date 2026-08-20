# Unfiltered — DESIGN.md

The design bar the yoyo loop enforces. `/yoyo-spec` gates UI milestones on
this file; `/yoyo-review` judges `[DESIGN]` findings against it, and a
must-fix must cite an invariant below by its ID (e.g. `W-3`, `P-4`).

This file holds rules that stay true while the UI changes. It never
describes the current UI.

Maintenance: a design-affecting PRD amendment updates this file in the same
PR. Larger direction changes are authored by re-running `/yoyo-design`.
There is no other update path and no generation pipeline.

Sources: PRD v2 (§3 parity floor, §5 UX and hard bar, §13 milestones); the
repository (`.claude/yoyo.md` `ui_paths`, the shadow-DOM widget); the
2026-08-15 design interview. No Claude Design upstream exists for this
project.

## Surfaces and which case applies

Unfiltered has three UI surfaces, and they do not share a case:

| Surface | Paths | Case | Governing idea |
|---|---|---|---|
| Storefront widget | `apps/shopify-app/extensions/`, `apps/shopify-app/widget/` | **Widget-class (inherits)** | The host store's design IS the design. |
| Merchant admin (dashboard, onboarding, settings) | `apps/shopify-app/app/routes/app.*` | **Platform-inherits** | Shopify Polaris IS the design ("Built for Shopify" is a PRD constraint). |
| Public playground | `apps/shopify-app/app/playground/`, `apps/shopify-app/app/routes/_index/` | **Owned pages** | The only surface Unfiltered draws itself; the direction system below applies. |

Rationale: PRD §5 rejects an Unfiltered-branded results page and caps the
shopper-visible footprint at chips-level; PRD §3 cap. 13 makes Built for
Shopify an engineering constraint from milestone 1; PRD §3 cap. 10 makes the
playground a public page with no host to inherit from.

## 1. Invariants

Each is imperative, atomic, and checkable from a screenshot or the diff.

### Floors — every surface (F)

- **F-1 Contrast.** All text and essential icons meet WCAG AA (4.5:1 body,
  3:1 large text and UI boundaries) in every theme and every state,
  including disabled, dimmed, and hover.
- **F-2 Reduced motion.** Under `prefers-reduced-motion: reduce`, no
  transform or opacity animation runs; state changes are instant.
- **F-3 Hit targets.** Every pointer-interactive element has a ≥ 44×44 CSS
  px hit area on touch (24×24 minimum for inline chip-remove affordances,
  with the whole chip clickable).
- **F-4 Keyboard.** Every interactive element is reachable and operable by
  keyboard, with a visible focus ring that meets 3:1 against its
  background. Overlays trap and restore focus.
- **F-5 RTL.** Layout uses logical properties only (`inline-start`,
  `margin-inline`, `padding-block`, `inset-inline`); no `left`/`right`
  positioning or margins in shopper-facing or playground CSS. Under
  `dir="rtl"` chip order, close controls, and grid flow mirror.
- **F-6 Every surface has designed loading, empty, and error states.** No
  spinner-only loading, no blank panels, no raw error strings. Where the
  PRD forbids shopper-visible errors (cap. 6), the error state IS the
  classic-results or quiet-empty state.
- **F-7 Localized chrome.** Every visible string in shopper-facing and
  playground surfaces comes from the string catalog with EN and HE
  entries; no hard-coded shopper-facing text in markup. The merchant
  admin is excluded (see A-4).
- **F-8 No layout shift on state change.** Loading → results → refinement
  do not move the search input; results replace, never stack.

### Widget-class — the storefront widget (W)

- **W-1 The host store's design is the design.** The widget adds
  behavior, not aesthetics. Nothing in it exists to look like Unfiltered.
- **W-2 Footprint ≤ chips-level.** Shopper-visible additions are limited
  to: the results overlay/grid, the removable filter chips, one
  new-search/close control, and status text. No logo, badge, watermark,
  "powered by", or branded color anywhere in the shopper path.
- **W-3 No foreign hue.** The widget introduces no hue the host page does
  not already have. Fixed fallback values are achromatic (grays derived
  from `currentColor` or neutral hex). Emphasis is by weight, opacity,
  border, and spacing — never by an Unfiltered accent color.
- **W-4 Inherit-first chrome.** Font family, text color, and direction
  are inherited from the host, never set. Panel background, border,
  radius, and shadow are derived from host values where readable
  (`currentColor`, inherited font, host custom properties when exposed)
  with a neutral fallback; a fixed value is acceptable only where no host
  value can be read.
- **W-5 Isolation.** All widget CSS lives inside the shadow root; no
  widget rule may select or restyle host elements, and no host stylesheet
  is modified. The only host element the widget touches is the search
  input it takes over, and only its placeholder and value.
- **W-6 Result cards mirror the host.** Card anatomy is image / title /
  price / availability in that order and nothing else; card proportions
  follow the host's product grid where detectable (square image
  fallback). No ratings, badges, or CTAs the store's own grid lacks.
- **W-7 Chips are removable filters, not tags.** Every chip shows its
  label and a remove affordance; removing one re-runs the search. Chips
  never appear on classic (keystroke-preview or classic-routed) results.
- **W-8 Quiet by default.** Preview and failure states are quieter (lower
  opacity, smaller type) than submitted-result states; the AI zero-hit
  state names what didn't match and offers close matches; no state ever
  uses error color or error language.
- **W-9 Parity floor is visual too.** For a simple query the overlay must
  read no worse than the theme's stock results: same or better density,
  no missing price/availability, no slower-feeling reveal.
- **W-10 Removal leaves no trace.** After self-removal or uninstall, the
  page is visually identical to never having installed the widget
  (placeholder restored, no orphaned host node or style).

**Theme-native path (Mirror Bar, PRD amendment 2026-08-16; YOY-100).**
When the widget renders results through the theme's own surfaces — the
theme's search-results page (its heading, results-count line, containers,
layout) holding cards the theme itself rendered — that theme-native page
content is judged against the theme's own rendering, not against W-3–W-6:
the bar is "indistinguishable from the store's native results page for
these results", and the count line states the widget's result count in the
theme's own wording and language. Owned chrome on that page — the filter
chips and their immediate controls, and status text — still judges against
the W-* invariants (inherit-first, no foreign hue, chips-level footprint).
On this path the light-DOM placement of that owned chrome is the mechanism,
not a W-5 violation: its rules are prefixed to its own elements and never
restyle host elements; the theme's page content it hides is hidden in place
and restored exactly (W-10 applies to leaving the results view too).

### Platform-inherits — merchant admin (A)

- **A-1 Polaris only.** Admin UI is composed from Polaris components and
  tokens; no custom color, type, radius, or shadow values, no
  third-party component kits, no Unfiltered brand color in the admin.
- **A-2 Polaris patterns for state.** Loading uses skeleton components;
  empty uses `EmptyState`; errors use `Banner`; destructive actions
  confirm via modal.
- **A-3 One hero metric.** The dashboard overview has exactly one visually
  dominant figure (search-attributed orders); all other metrics are
  subordinate in size and weight.
- **A-4 English only in v1**, LTR, and no locale switch UI.

### Owned pages — playground (P)

- **P-1 Storefront-quiet.** The playground reads as a calm fashion
  storefront, not a SaaS landing page or a tool. Product photography
  supplies all chromatic color other than the single accent.
- **P-2 One accent hue per view**, used only for the search bar's active
  state, the primary action, and links. Never for backgrounds, cards, or
  chips.
- **P-3 The search bar is the hero and the only branded element** on the
  page: it is the largest interactive element and above the fold on
  every viewport; nothing else on the page uses display-size type.
- **P-4 Engine details are opt-in.** Chips are always shown on AI
  results; route, latency, and extracted intent are hidden behind a
  single "how it understood you" toggle, off by default.
- **P-5 Same widget language.** Chips, cards, and states in the
  playground use the same anatomy and rules as W-6, W-7, W-8, so what
  the playground previews is what a store gets.
- **P-6 Fashion-only content.** Seed catalog, example queries, and
  imagery are fashion; example queries appear in EN and HE.
- **P-7 Store-preload mode is visibly the store's.** With a store's
  catalog preloaded, the store's name is the only new element; the
  page's own chrome does not change.
- **P-8 Tokens, not literals.** All color, spacing, radius, and type
  values in playground CSS reference the tokens in §2; no raw hex or
  pixel literals outside the token definitions.

### Anti-patterns — must never appear (X)

- **X-1** Purple/violet-to-blue gradients, glassmorphism panels, glowing
  borders, or "sparkle"/✨ iconography signalling "AI".
- **X-2** A chat bubble, avatar, or conversational transcript UI (PRD
  §4.2: not a chatbot).
- **X-3** Any "powered by Unfiltered" or logo in the shopper path.
- **X-4** Skeleton shimmer, spinners, or typing-dots inside the storefront
  overlay; loading is a single quiet status line.
- **X-5** Toasts, banners, or modals in the shopper path.
- **X-6** Emoji as UI, decorative illustrations, or stock-photo heroes on
  the playground.
- **X-7** Mixed-direction layout bugs: Latin punctuation stranded at the
  wrong end of a Hebrew string, LTR-only icons (arrows) unmirrored.

## 2. Direction system

Applies to the **playground only** (owned pages). The widget deliberately
has none — writing a type scale for a surface that must disappear into its
host would violate W-1. The admin's system is Polaris.

### Type
- Family: one neutral variable grotesk with Latin + Hebrew coverage
  (Inter-class), used for both scripts; no serif, no display face.
- Scale: major third (1.25), base 16px: **13 / 16 / 20 / 25 / 31 / 39**.
  Only the search input and its placeholder may use ≥ 25.
- Line height: 1.5 body, 1.2 headings. Weights: 400 body, 500 UI, 600
  emphasis; nothing bolder.

### Spacing
- Base 4px; scale **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64**. Component
  internal padding ≤ 16; section rhythm ≥ 32.
- Content max inline-size 1200px; results grid `auto-fill, minmax(180px,
  1fr)` on desktop, two columns minimum on mobile.

### Color tokens (roles → hex anchors)
| Role | Light | Dark |
|---|---|---|
| `--bg` | `#FAF9F7` | `#141414` |
| `--surface` | `#FFFFFF` | `#1C1C1C` |
| `--text` | `#141414` | `#F2F1EE` |
| `--text-muted` | `#5C5A56` | `#A8A5A0` |
| `--border` | `#E4E1DC` | `#2E2C29` |
| `--accent` | `#1F3A93` | `#8FA5FF` |
| `--accent-contrast` | `#FFFFFF` | `#141414` |

Rules: exactly these roles; no additional chromatic tokens; muted text
must still meet AA (P-8, F-1). Dark theme follows `prefers-color-scheme`.

### Shape and elevation
- Radius: **8px** controls and chips-as-pills (`999px`), **12px** cards
  and panels. Nothing else.
- Elevation: one shadow only, for the results panel over content:
  `0 8px 32px rgba(0,0,0,.12)`; cards use border, not shadow.

### Motion budget
- Durations: 120ms (hover/focus), 200ms (panel open, chip add/remove).
  Nothing longer; nothing loops.
- Easing: `cubic-bezier(.2,0,0,1)` (ease-out) for entrances; linear for
  opacity fades.
- Never animated: layout of the search bar, result-grid reflow, text.
  Under reduced motion all of the above are 0ms (F-2).

### Component language (rules, not inventory)
- **Search bar:** full-width within content, height 56px desktop / 48
  mobile, 1px `--border` at rest and 2px `--accent` when focused; the
  submit magnifier is inside the field at the inline-end.
- **Chips:** pill, `--surface` on `--border`, label + remove glyph;
  hover darkens border only. Same anatomy as the widget.
- **Cards:** image (square, cover), title (16/500), price (16/400,
  muted), availability pill when sold out; 1px `--border`, no shadow.
- **Buttons:** primary = `--accent` fill / `--accent-contrast` text;
  secondary = `--surface` with `--border`; only one primary per view.
- **Engine-details panel (P-4):** monospace is permitted here only, for
  the extracted-intent JSON; muted text; collapses fully when off.
- **States:** loading = quiet status line in muted text under the bar;
  empty = one sentence naming what didn't match plus close matches;
  error = the classic-results state, never an error card.
