import { useState } from "react";

import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { FilterChip, type Chip } from "../components/FilterChip";
import {
  ProductResultCard,
  type Product,
} from "../components/ProductResultCard";
import { QueryBreakdown } from "../components/QueryBreakdown";
import { SearchBar } from "../components/SearchBar";
import { SitePage } from "../components/SitePage";
import { SITE_ASSETS, SITE_ROUTES } from "../paths";

const P = SITE_ASSETS.placeholder;

const BASE_CHIPS: Chip[] = [
  { label: "Dresses", variant: "include" },
  { label: "Under ₪400", variant: "include" },
  { label: "Not black", variant: "exclude" },
  { label: "Hides midsection", variant: "derived" },
];

interface RefineScene {
  query: string;
  chips: Chip[];
  results: Product[];
  note: string;
}

const BASE: RefineScene = {
  query: "elegant summer wedding dress, not black, under ₪400",
  chips: [
    { label: "Dresses", variant: "include" },
    { label: "Under ₪400", variant: "include" },
    { label: "Not black", variant: "exclude" },
    { label: "Wedding guest", variant: "derived" },
  ],
  results: [
    {
      image: P(1),
      brand: "Maison Ora",
      title: "Silk-blend midi dress",
      price: "₪389",
      matches: ["Silk blend"],
    },
    {
      image: P(3),
      brand: "Talia",
      title: "Pleated wrap gown",
      price: "₪365",
      matches: ["Wrap waist"],
    },
    {
      image: P(5),
      brand: "Noa Levi",
      title: "Linen column dress",
      price: "₪298",
      matches: ["Linen"],
    },
  ],
  note: "4 constraints understood · 38 matches",
};

const REFINED: RefineScene = {
  query: "same but cheaper",
  chips: [
    { label: "Dresses", variant: "include" },
    { label: "Under ₪250", variant: "include" },
    { label: "Not black", variant: "exclude" },
    { label: "Wedding guest", variant: "derived" },
    { label: "Kept from previous", variant: "derived" },
  ],
  results: [
    {
      image: P(5),
      brand: "Noa Levi",
      title: "Linen shift dress",
      price: "₪218",
      matches: ["Under ₪250"],
    },
    {
      image: P(2),
      brand: "Adira",
      title: "Cotton poplin dress",
      price: "₪189",
      matches: ["Under ₪250"],
    },
    {
      image: P(6),
      brand: "Talia",
      title: "Crepe slip dress",
      price: "₪245",
      matches: ["Under ₪250"],
    },
  ],
  note: "Price ceiling lowered · every other constraint carried over",
};

const INGESTION = [
  [
    "Text fields",
    "Titles, descriptions, tags, product type, vendor, variant names, metafields. Fabric and fit notes buried in description HTML get parsed out.",
  ],
  [
    "Product images",
    "Sleeve length, neckline, silhouette, pattern and colour are read from the photography, so a dress nobody tagged “sleeveless” still answers “sleeveless”.",
  ],
  [
    "Commerce signals",
    "Price, stock and variant availability, so “under ₪400” means in stock under ₪400.",
  ],
  [
    "Kept current",
    "Product webhooks re-index a changed item in minutes. A full catalogue of 5,000 products takes about 20 minutes on first install.",
  ],
] as const;

const FALLBACK = [
  [
    "700ms",
    "Budget for an AI response. Past it, the query is handed to your theme's own search and the results render as they always did.",
  ],
  [
    "silent",
    "The shopper sees results, not a warning. No spinner that never ends, no empty state, no “try again”.",
  ],
  [
    "logged",
    "You see every fallback in your admin, with the reason. Fallbacks never count as AI searches.",
  ],
] as const;

function LiveBreakdown() {
  const [removed, setRemoved] = useState<string[]>([]);
  const kept = BASE_CHIPS.filter((chip) => !removed.includes(chip.label));
  const matchLine =
    kept.length +
    (kept.length === 1 ? " constraint active · " : " constraints active · ") +
    (38 + removed.length * 26) +
    " matches";

  return (
    <div className="site-panel site-panel--white">
      <QueryBreakdown
        query="elegant summer wedding dress, not black, under ₪400, hides my belly"
        chips={kept}
        onRemove={(chip) => setRemoved((r) => [...r, chip.label])}
      />
      <div className="site-breakdown__foot">
        <span className="site-breakdown__line">{matchLine}</span>
        <button
          type="button"
          className="site-text-button"
          onClick={() => setRemoved([])}
        >
          Reset chips
        </button>
      </div>
    </div>
  );
}

function Refinement() {
  const [refined, setRefined] = useState(false);
  const scene = refined ? REFINED : BASE;

  return (
    <div className="site-container site-split site-feature">
      <div>
        <span className="site-eyebrow">Follow-up refinement</span>
        <h2 className="site-h2 site-feature__title">
          “Same but cheaper” is a complete sentence.
        </h2>
        <p className="site-feature__body">
          A follow-up query keeps everything already understood and changes only
          what the shopper asked to change. No re-typing the original sentence,
          no starting over from the category page.
        </p>
        <div className="site-refine__toggles">
          <button
            type="button"
            className="site-toggle"
            onClick={() => setRefined(false)}
          >
            First query
          </button>
          <button
            type="button"
            className="site-toggle"
            onClick={() => setRefined(true)}
          >
            Then: “same but cheaper”
          </button>
        </div>
      </div>
      <div className="site-panel">
        <SearchBar size="compact" value={scene.query} />
        <div className="site-refine__chips">
          <span className="site-eyebrow">Understood as</span>
          {scene.chips.map((chip) => (
            <FilterChip
              key={chip.label}
              label={chip.label}
              variant={chip.variant}
            />
          ))}
        </div>
        <div className="site-refine__results">
          {scene.results.map((product) => (
            <ProductResultCard key={product.title} {...product} />
          ))}
        </div>
        <p className="site-refine__note">{scene.note}</p>
      </div>
    </div>
  );
}

export function HowItWorksPage() {
  return (
    <SitePage>
      <section className="site-hiw-hero">
        <span className="site-eyebrow">How it works</span>
        <h1 className="site-hiw-hero__title">
          Two kinds of search, one search box.
        </h1>
        <p className="site-hiw-hero__lede">
          Short queries never wait for a model. Sentences get read properly.
          Your shopper never has to know which one they typed.
        </p>
      </section>

      <section className="site-band site-hiw-section">
        <div className="site-container">
          <span className="site-eyebrow">The search ladder</span>
          <h2 className="site-h2 site-hiw__title">
            Keyword when keyword is right. AI when it isn&apos;t.
          </h2>
          <div className="site-ladder">
            <div className="site-rung">
              <div className="site-rung__head">
                <Badge>Rung one</Badge>
                <span className="site-mono-note">
                  ~40ms · no AI search used
                </span>
              </div>
              <h3 className="site-rung__query">“linen dress”</h3>
              <p className="site-rung__body">
                Two words, one product type. This is a keyword query, so it
                stays a keyword query — instant results straight from the index.
              </p>
              <SearchBar size="compact" value="linen dress" />
              <div className="site-rung__results">
                <ProductResultCard
                  image={P(5)}
                  brand="Noa Levi"
                  title="Linen column dress"
                  price="₪298"
                />
                <ProductResultCard
                  image={P(2)}
                  brand="Adira"
                  title="Washed linen shirtdress"
                  price="₪412"
                />
              </div>
            </div>
            <div className="site-rung site-rung--featured">
              <div className="site-rung__head">
                <Badge tone="accent">Rung two</Badge>
                <span className="site-mono-note">~600ms · 1 AI search</span>
              </div>
              <h3 className="site-rung__query">
                “something floaty for a beach wedding in september”
              </h3>
              <p className="site-rung__body">
                A sentence with an occasion, a season and a feel. Nothing in it
                is a tag. This one goes up the ladder.
              </p>
              <SearchBar
                size="compact"
                value="something floaty for a beach wedding in september"
              />
              <div className="site-rung__results">
                <ProductResultCard
                  image={P(6)}
                  brand="Talia"
                  title="Georgette maxi dress"
                  price="₪340"
                  flag="Best match"
                  matches={["Georgette", "Maxi length"]}
                />
                <ProductResultCard
                  image={P(4)}
                  brand="Maison Ora"
                  title="Tiered voile dress"
                  price="₪455"
                  matches={["Voile", "Warm weather"]}
                />
              </div>
            </div>
          </div>
          <p className="site-ladder__note">
            The decision is made per query, before anything is spent. Roughly
            two thirds of storefront searches are short enough to stay on rung
            one.
          </p>
        </div>
      </section>

      <section className="site-hiw-section">
        <div className="site-container site-split site-feature">
          <div>
            <span className="site-eyebrow">Understood intent</span>
            <h2 className="site-h2 site-feature__title">
              We show our reading of the sentence, and let it be wrong.
            </h2>
            <p className="site-feature__body">
              Every constraint we take from a query becomes a chip. Solid chips
              are what the shopper said. Dashed chips are what we inferred. Any
              chip can be removed, and results update without a reload.
            </p>
            <p className="site-feature__hint">
              Try removing one — the demo on the right is live.
            </p>
          </div>
          <LiveBreakdown />
        </div>
      </section>

      <section className="site-band site-hiw-section">
        <Refinement />
      </section>

      <section className="site-hiw-section">
        <div className="site-container">
          <span className="site-eyebrow">Catalogue ingestion</span>
          <h2 className="site-h2 site-hiw__title">
            We read everything you already wrote — and everything you
            photographed.
          </h2>
          <div className="site-ingest">
            {INGESTION.map(([title, body]) => (
              <div key={title} className="site-ingest__item">
                <h3 className="site-ingest__title">{title}</h3>
                <p className="site-ingest__body">{body}</p>
              </div>
            ))}
          </div>
          <div className="site-readonly">
            <p className="site-readonly__lead">Read-only, always.</p>
            <p className="site-readonly__body">
              We request read scopes on products, collections and orders. We
              never write to your catalogue, never edit tags, never touch your
              theme files. Uninstalling removes our index; nothing in your store
              changes.
            </p>
          </div>
        </div>
      </section>

      <section className="site-band site-band--top site-hiw-section">
        <div className="site-container site-split site-feature">
          <div>
            <span className="site-eyebrow">The fallback</span>
            <h2 className="site-h2 site-feature__title site-feature__title--wide">
              If our AI ever slows down or fails, shoppers instantly get your
              store&apos;s normal search.
            </h2>
            <p className="site-fallback__lead">No error states, ever.</p>
          </div>
          <div className="site-fallback__list">
            {FALLBACK.map(([tag, body]) => (
              <div key={tag} className="site-fallback__item">
                <span className="site-fallback__tag">{tag}</span>
                <p className="site-fallback__body">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="site-hiw-closer">
        <div className="site-container site-split site-hiw-closer__grid">
          <h2 className="site-h2 site-hiw-closer__title">
            Install to your first working AI search in under 10 minutes.
          </h2>
          <div className="site-actions site-hiw-closer__actions">
            <Button size="lg" href={SITE_ROUTES.pricing}>
              See pricing
            </Button>
            <Button size="lg" variant="secondary" href={SITE_ROUTES.demo}>
              Try the live demo
            </Button>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
