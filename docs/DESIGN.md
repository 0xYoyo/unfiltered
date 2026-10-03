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
2026-08-15 design interview; and, for §2 and the P-* invariants as
re-authored on 2026-08-28, the founder's Claude-Design kit "Unfiltered
marketing landing page" via the binding YOY-123 design comment.

## Surfaces and which case applies

Unfiltered has four UI surfaces, and they do not share a case:

| Surface | Paths | Case | Governing idea |
|---|---|---|---|
| Storefront widget | `apps/shopify-app/extensions/`, `apps/shopify-app/widget/` | **Widget-class (inherits)** | The host store's design IS the design. |
| Merchant admin (dashboard, onboarding, settings) | `apps/shopify-app/app/routes/app.*` | **Platform-inherits** | Shopify Polaris IS the design ("Built for Shopify" is a PRD constraint). |
| Public playground | `apps/shopify-app/app/playground/`, `apps/shopify-app/app/routes/try.tsx`, `apps/shopify-app/app/routes/s.$slug.tsx` | **Owned pages** | Drawn by Unfiltered; the direction system below applies. |
| Marketing site | `apps/shopify-app/app/site/`, `apps/shopify-app/app/routes/_index/` and the site page routes (`about`, `how-it-works`, `pricing`, `faq`, `privacy`, `terms`) | **Owned pages** | Drawn by Unfiltered on the same §2 tokens as the playground; its nav and footer also frame the playground at `/try`. |

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
  A chip for an EXCLUSION is distinguishable from an inclusion at a
  glance, marked achromatically — a heavier border and the excluded value
  struck through, both in the host's own inherited colour, with the
  negator word left upright — never by a hue of ours (W-3). The
  playground marks the same distinction with its accent tint (P-9); only
  the means differ, because only the playground may own a hue.
  One chip has no remove affordance: the two-meanings chip (PRD §3 "Two
  meanings"), "{reading} instead?", which offers another search rather
  than filtering this one — a dashed hairline in the host's own colour in
  the widget, a ghost pill on the playground.
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

Re-authored 2026-08-28 from the founder's Claude-Design kit ("Unfiltered
marketing landing page") and the binding YOY-123 design comment. The
playground is OUR surface, not a merchant theme: the Mirror-Bar
preservation rules do not apply to it, and this page carries the
Unfiltered brand.

- **P-1 Storefront-quiet.** The playground reads as a calm fashion
  storefront on ivory, not a SaaS landing page or a tool. Product
  photography supplies all chromatic color other than the single accent
  and the ink scale.
- **P-2 One accent hue.** The red accent fills exactly one element — the
  search bar's submit control — and otherwise appears only as link text,
  the focused field's border and ring, and the soft tint behind a NEGATED
  chip (P-9). Never as a page or card background, never on the language
  pill, "New search", or an ordinary chip.
- **P-3 The search is the page's subject.** The hero heading and the
  search bar are the only display-scale elements, in that order, and the
  bar sits inside its own white card above the fold at every viewport.
  Nothing below the card uses display-scale type.
- **P-4 Engine details are opt-in.** Chips are always shown on AI
  results; route, latency, and extracted intent are hidden behind a
  single "how it understood you" toggle, off by default, and open into
  the page's one inverse panel.
- **P-5 Same widget anatomy.** Chips, cards, and states in the playground
  use the same ANATOMY and behaviour as W-6, W-7, W-8, so what the
  playground previews is what a store gets. The skin is not shared: the
  widget stays inherit-first inside its host (W-3, W-4) while the
  playground wears this direction.
- **P-6 Fashion-only content.** Seed catalog, example queries, and
  imagery are fashion; example queries appear in EN and HE.
- **P-7 Store-preload mode is visibly the store's.** With a store's
  catalog preloaded, the store's name takes the demo hero's place and is
  the only new element; nothing else about the page changes.
- **P-8 Tokens, not literals.** All color, spacing, radius, type, motion,
  and shadow values in playground CSS reference the tokens in §2; no raw
  hex or pixel literals outside `tokens.css`.
- **P-9 Negation is visible.** A chip for an excluded constraint ("not
  wool", "not black") is distinguishable from an inclusion at a glance,
  by the accent tint and border of §2's chip rule — never by the label
  alone. The widget must make the same distinction, and may not use this
  means to do it (W-3, W-7).
- **P-10 One theme.** The playground is the ivory direction only; it
  declares no dark palette and does not switch on
  `prefers-color-scheme`. The kit fixes one page on one ground, and a
  second palette nobody authored would be invention, not direction.

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

Revision **2026-08-28**. Applies to the **owned pages** — the playground
and the marketing site, which share `tokens.css` as their one token source.
The P-* invariants remain the playground's.
The widget deliberately has none — writing a type scale for a surface that
must disappear into its host would violate W-1. The admin's system is
Polaris.

Source: the founder's Claude-Design kit "Unfiltered marketing landing
page" (2026-08-28), reproduced verbatim in the token block below via the
binding YOY-123 design comment. This replaced the 2026-08-15 interview's
neutral-grotesk/indigo direction wholesale.

### Voice

Plain, specific, quietly confident. Sentence case everywhere — headings,
buttons, labels — with uppercase reserved for the eyebrow style alone. No
hype and no "powered by AI". Second person for the merchant; "we" only for
what we do on their behalf. The tagline direction is "Your shoppers don't
think in filters."

### Tokens

`apps/shopify-app/app/playground/tokens.css` is this block, byte for byte;
`playground-css.test.ts` asserts it. Adding, removing, or re-valuing a
token is an edit to this section first.

```css
:root{
  --ivory-50:#FDFBF7;--ivory-100:#FAF7F2;--ivory-200:#F4EFE7;--sand-300:#EDE6DA;--sand-400:#E3DBCC;
  --line-200:#E7E0D4;--line-300:#D8CFC0;
  --ink-900:#1A1815;--ink-800:#2B2823;--ink-700:#443F38;--ink-600:#6B645A;--ink-500:#8C8477;--ink-400:#ADA598;
  --white:#FFFFFF;
  --red-700:#8E241A;--red-600:#B02F22;--red-500:#D33A2C;--red-400:#E4675A;--red-100:#FAE4E0;--red-50:#FDF2EF;
  --green-600:#2E6B50;--green-100:#E3EDE7;--gold-600:#9A6C15;--gold-100:#F4EBD9;
  --oxblood-700:#6E1F14;--oxblood-100:#F2E2DE;
  --bg-page:var(--ivory-100);--bg-page-alt:var(--ivory-200);
  --surface-card:var(--white);--surface-sunken:var(--ivory-200);--surface-inverse:var(--ink-900);--surface-accent-soft:var(--red-50);
  --text-display:var(--ink-900);--text-body:var(--ink-800);--text-muted:var(--ink-600);--text-faint:var(--ink-500);
  --text-inverse:var(--ivory-100);--text-accent:var(--red-600);--text-critical:var(--oxblood-700);
  --border-hairline:var(--line-200);--border-strong:var(--line-300);--border-ink:var(--ink-900);--border-accent:var(--red-500);
  --accent:var(--red-500);--accent-hover:var(--red-600);--accent-press:var(--red-700);--accent-soft:var(--red-100);
  --focus-ring:var(--red-500);--overlay-scrim:rgba(26,24,21,.44);
  --font-display:"Frank Ruhl Libre",'Times New Roman',Georgia,serif;
  --font-sans:"Assistant",-apple-system,"Segoe UI",Helvetica,sans-serif;
  --font-mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --size-display-1:76px;--size-display-2:56px;--size-display-3:42px;--size-h1:32px;--size-h2:25px;--size-h3:20px;
  --size-body-lg:18px;--size-body:16px;--size-body-sm:14px;--size-caption:12.5px;--size-eyebrow:11.5px;
  --lh-display:1.04;--lh-heading:1.18;--lh-body:1.6;--lh-tight:1.3;
  --weight-light:300;--weight-regular:400;--weight-medium:500;--weight-semibold:600;--weight-bold:700;--weight-black:900;
  --track-display:-0.02em;--track-heading:-0.01em;--track-eyebrow:0.16em;
  --radius-xs:2px;--radius-sm:4px;--radius-md:8px;--radius-lg:14px;--radius-pill:999px;
  --border-width:1px;--border-width-thick:1.5px;
  --shadow-1:0 1px 2px rgba(26,24,21,.05);--shadow-2:0 2px 10px rgba(26,24,21,.06);--shadow-3:0 12px 32px rgba(26,24,21,.10);--shadow-lift:0 6px 20px rgba(26,24,21,.09);
  --ring-focus:0 0 0 3px rgba(211,58,44,.28);
  --space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;--space-7:48px;--space-8:64px;--space-9:96px;
  --measure-prose:64ch;--width-container:1200px;--width-container-narrow:920px;
  --ease-standard:cubic-bezier(.22,.61,.36,1);--dur-fast:120ms;--dur-base:180ms;--dur-slow:320ms;--dur-chip-out:200ms;
  --motion-hover:all var(--dur-fast) var(--ease-standard);
}

/* Measurements the §4 page spec fixes but the kit's token block does not
   name. They are pixel values the component rules need (a 44px hit floor
   is F-3, not taste), and P-8 forbids them anywhere but this file. Kept in
   their own block so the kit block above stays verbatim. */
:root {
  /* F-3: the pointer-interactive floor, and the touch-only chip floor. */
  --hit-target-min: 44px;
  --hit-target-inline-min: 24px;
  /* The hero bar's own height, desktop and ≤ 640px (kit §4 search card). */
  --search-height: 60px;
  --search-height-compact: 52px;
  /* Results grid: the kit's §4 180px track floor, laid out with
     `auto-fill` — the deviation §2 Layout records. */
  --card-min-inline-size: 180px;
  /* Focus is a ring token (--ring-focus); the outline fallback needs a
     width and an offset of its own. */
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
}
```

Fonts are self-hosted from `apps/shopify-app/public/fonts/` rather than
fetched from the kit's Google Fonts URL: the app fetches no font from a
third-party host, which is asserted, and the faces are identical. Frank
Ruhl Libre and Assistant were both drawn with Hebrew in the family, so one
face per role serves both scripts and there is no separate Hebrew stack.

### Type
- Roles: `--font-display` (Frank Ruhl Libre) for the wordmark, the hero
  heading, the store name, and section headings; `--font-sans`
  (Assistant) for everything else; `--font-mono` (IBM Plex Mono) for
  prices and the engine panel's timings and intent JSON, and nowhere
  else.
- Scale: the `--size-*` tokens only. The hero heading is
  `clamp(--size-h1, 6vw, --size-display-2)`; the search input is
  `--size-body-lg`; body is `--size-body`; secondary and control text
  `--size-body-sm`; captions `--size-caption`; the eyebrow style is
  `--size-eyebrow` uppercase at `--track-eyebrow`.
- Line height: `--lh-display` for the hero, `--lh-heading` for headings,
  `--lh-body` for prose, `--lh-tight` for controls. Weights: regular
  body, medium for UI and headings, semibold for eyebrows; nothing
  heavier on the page.

### Layout and spacing
- Spacing is the `--space-*` scale only; section rhythm ≥ `--space-6`.
- One column, `--width-container-narrow` centred, on `--bg-page`. Prose
  is capped at `--measure-prose`.
- Results grid `repeat(auto-fill, minmax(--card-min-inline-size, 1fr))`
  with `--space-4` gap on desktop, two columns minimum below 640px.
  `auto-fill` rather than the kit's `auto-fit`: auto-fit stretches a
  two-card answer into two 440px cards, so the same query answered by two
  results and by eight would read as two different pages. Empty tracks keep
  card size constant.

### Color
- The page is `--bg-page` ivory; the search card and cards' image wells
  are the only lighter surfaces. Text is the ink scale: `--text-display`,
  `--text-body`, `--text-muted`, `--text-critical`. `--text-faint` is
  defined by the kit but is NOT used for text on this page: it measures
  3.46:1 on `--bg-page`, under the F-1 floor, and every quiet role here is
  small type. `--text-muted` is the quiet ink (5.47:1 on the page, 5.84:1
  on a card).
- The accent is `--accent`, used per P-2 and nowhere else. `--focus-ring`
  and `--ring-focus` are the focus treatment. The engine panel is the one
  `--surface-inverse` region.
- Single theme (P-10): no `prefers-color-scheme` block, in this file or
  in `tokens.css`.

### Shape and elevation
- Radius: `--radius-sm` for controls, fields, and card images;
  `--radius-md` for the search card and the engine panel; `--radius-pill`
  for chips and the language toggle.
- Elevation: `--shadow-1` rests under the search card, `--shadow-2` is a
  card's hover lift. Result cards carry no border and no fill — the
  photograph is the card.

### Component language (rules, not inventory)
- **Top bar:** wordmark in the display face at `--weight-medium`, and the
  language toggle as a hairline pill with no fill. No other navigation.
- **Hero:** eyebrow, heading, one paragraph of sub-copy at
  `--measure-prose`. Absent on a store-preload page (P-7).
- **Search card:** `--surface-card` on a hairline border at
  `--radius-md`, holding the bar, the status line, and the example
  queries. The bar is full width with the submit control filled
  `--accent` at the inline-end; focus takes `--border-accent` plus
  `--ring-focus`.
- **Chips:** pill, hairline `--border-strong` on `--surface-card`, label
  plus `×`; hover darkens the border to `--border-ink` and the `×` to
  `--text-accent`. A negated chip adds `--surface-accent-soft` on
  `--border-accent` (P-9). Removal animates out over `--dur-chip-out`.
  "New search" is a ghost pill of the same shape with no fill.
- **Cards:** image at 3/4 cover, title at `--size-body` medium, price in
  `--font-mono` muted, availability pill when sold out. Hover lifts with
  `--shadow-2` and changes nothing else.
- **Engine panel (P-4):** `--surface-inverse` with `--text-inverse`,
  `--font-mono` at `--size-caption`; collapses out of the DOM when off.
- **States:** loading before the first answer is sunken skeleton cards at
  the card proportion, with no shimmer and no motion; a refinement never
  blanks the results already on screen. Empty is one display-face line
  naming what did not match plus close matches. A failed request is one
  plain sentence in `--text-critical` under the bar, never a box or a
  banner, with the previous results left in place.

### Motion budget
- Durations: `--dur-fast` (hover, focus), `--dur-base` (entrances),
  `--dur-chip-out` (chip removal). Nothing longer, nothing loops,
  nothing moves on its own.
- Easing: `--ease-standard`.
- Never animated: the search bar's layout, result-grid reflow, text.
  Under reduced motion every transition is 0ms and the chip removal
  fires at once (F-2).
