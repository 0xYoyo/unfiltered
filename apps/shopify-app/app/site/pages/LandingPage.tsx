import { useEffect, useState } from "react";

import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { FilterChip, type Chip } from "../components/FilterChip";
import { PricingTiers } from "../components/PricingCard";
import {
  ProductResultCard,
  type Product,
} from "../components/ProductResultCard";
import { SearchBar } from "../components/SearchBar";
import { SitePage } from "../components/SitePage";
import { StatCard } from "../components/StatCard";
import { SITE_ASSETS, SITE_ROUTES, TRY_CTA_LABEL } from "../paths";

/**
 * "/" — the landing page. The hero card replays three scripted searches:
 * the sentence types itself, its chips arrive, then its results. Under
 * `prefers-reduced-motion` the first scene is shown complete and nothing
 * moves (readme "Motion").
 */

interface Scene {
  query: string;
  chips: Chip[];
  results: Product[];
}

const P = SITE_ASSETS.placeholder;

const SCENES: Scene[] = [
  {
    query:
      "elegant summer wedding dress, not black, under ₪400, hides my belly",
    chips: [
      { label: "Dresses" },
      { label: "Under ₪400" },
      { label: "Not black", variant: "exclude" },
      { label: "Hides midsection", variant: "derived" },
    ],
    results: [
      {
        image: P(1),
        brand: "Maison Ora",
        title: "Silk-blend midi dress",
        price: "₪389",
        flag: "Best match",
        matches: ["Midi length", "Not black"],
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
      {
        image: P(2),
        brand: "Adira",
        title: "Chiffon slip dress",
        price: "₪412",
        matches: ["Bias cut"],
      },
    ],
  },
  {
    query: "something floaty for a beach wedding in september",
    chips: [
      { label: "Dresses" },
      { label: "Floaty fabrics", variant: "derived" },
      { label: "Beach wedding" },
      { label: "Warm weather", variant: "derived" },
    ],
    results: [
      {
        image: P(6),
        brand: "Talia",
        title: "Georgette maxi dress",
        price: "₪340",
        flag: "Best match",
        matches: ["Georgette", "Maxi length"],
      },
      {
        image: P(4),
        brand: "Maison Ora",
        title: "Tiered voile dress",
        price: "₪455",
        matches: ["Voile"],
      },
      {
        image: P(5),
        brand: "Noa Levi",
        title: "Linen column dress",
        price: "₪298",
        matches: ["Breathable"],
      },
      {
        image: P(2),
        brand: "Adira",
        title: "Chiffon slip dress",
        price: "₪412",
        matches: ["Bias cut"],
      },
    ],
  },
  {
    query: "long sleeve dress for a winter wedding, warm but not frumpy",
    chips: [
      { label: "Dresses" },
      { label: "Long sleeve" },
      { label: "Not frumpy", variant: "derived" },
      { label: "Heavier fabrics", variant: "derived" },
    ],
    results: [
      {
        image: P(3),
        brand: "Talia",
        title: "Pleated wrap gown",
        price: "₪365",
        flag: "Best match",
        matches: ["Long sleeve", "Crepe"],
      },
      {
        image: P(1),
        brand: "Maison Ora",
        title: "Silk-blend midi dress",
        price: "₪389",
        matches: ["Defined waist"],
      },
      {
        image: P(4),
        brand: "Maison Ora",
        title: "Tiered voile dress",
        price: "₪455",
        matches: ["Layered"],
      },
      {
        image: P(6),
        brand: "Talia",
        title: "Georgette maxi dress",
        price: "₪340",
        matches: ["Maxi length"],
      },
    ],
  },
];

interface DemoState {
  scene: number;
  typed: string;
  chipCount: number;
  resultCount: number;
  removed: string[];
}

const EMPTY: DemoState = {
  scene: 0,
  typed: "",
  chipCount: 0,
  resultCount: 0,
  removed: [],
};

/** The scripted hero demo, timed as the export times it. */
function useHeroDemo(): [DemoState, (label: string) => void] {
  const [state, setState] = useState<DemoState>(EMPTY);

  useEffect(() => {
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });

    const run = async () => {
      if (reduced) {
        const first = SCENES[0];
        setState({
          ...EMPTY,
          typed: first.query,
          chipCount: first.chips.length,
          resultCount: first.results.length,
        });
        return;
      }
      for (let i = 0; alive; i++) {
        const index = i % SCENES.length;
        const scene = SCENES[index];
        setState({ ...EMPTY, scene: index });
        await wait(1000);
        if (!alive) return;
        for (let c = 1; c <= scene.query.length; c++) {
          const ch = scene.query[c - 1];
          setState((s) => ({ ...s, typed: scene.query.slice(0, c) }));
          await wait(
            ch === " " ? 80 : ch === "," ? 130 : 46 + Math.random() * 26,
          );
          if (!alive) return;
        }
        await wait(900);
        for (let c = 1; c <= scene.chips.length; c++) {
          setState((s) => ({ ...s, chipCount: c }));
          await wait(430);
          if (!alive) return;
        }
        await wait(620);
        for (let c = 1; c <= scene.results.length; c++) {
          setState((s) => ({ ...s, resultCount: c }));
          await wait(220);
          if (!alive) return;
        }
        await wait(5600);
        if (!alive) return;
      }
    };
    void run();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const remove = (label: string) =>
    setState((s) => ({ ...s, removed: [...s.removed, label] }));

  return [state, remove];
}

function HeroDemo() {
  const [state, remove] = useHeroDemo();
  const scene = SCENES[state.scene];
  const chips = scene.chips
    .slice(0, state.chipCount)
    .filter((chip) => !state.removed.includes(chip.label));
  const results = scene.results.slice(0, state.resultCount);

  return (
    <div dir="ltr" className="site-hero__demo">
      <SearchBar value={state.typed} />
      <div className="site-hero__chips">
        <span className="site-eyebrow">Understood as</span>
        {chips.map((chip) => (
          <span key={chip.label} className="unf-rise site-hero__chip">
            <FilterChip
              label={chip.label}
              variant={chip.variant ?? "include"}
              onRemove={() => remove(chip.label)}
            />
          </span>
        ))}
      </div>
      <div className="site-hero__results">
        {results.map((product) => (
          <div key={product.title} className="unf-rise">
            <ProductResultCard {...product} />
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  [
    "01",
    "Install",
    "One click from the Shopify App Store. No theme code, no dev.",
  ],
  [
    "02",
    "We read your catalogue",
    "Titles, tags, fabrics, fit notes, product images. Install to your first working AI search on your own products in under 10 minutes.",
  ],
  [
    "03",
    "Shoppers type like people",
    "“Something floaty for a beach wedding” returns the six pieces that actually fit.",
  ],
  [
    "04",
    "You see the revenue",
    "Every order traces back to the sentence that produced it.",
  ],
] as const;

export function LandingPage() {
  return (
    <SitePage>
      <section id="top" className="site-hero">
        <h1 className="site-hero__title">
          Your shoppers don&apos;t think in filters.
        </h1>
        <p className="site-hero__lede">
          Unfiltered replaces your filter sidebar with a search box that reads
          whole sentences and shows you the orders it earned.
        </p>
        <div className="site-actions site-hero__actions">
          <Button size="lg" href={SITE_ROUTES.demo}>
            {TRY_CTA_LABEL}
          </Button>
          <Button size="lg" variant="secondary" href={SITE_ROUTES.demo}>
            See a demo store
          </Button>
        </div>
        <HeroDemo />
      </section>

      <section id="how" className="site-band site-how">
        <div className="site-container">
          <span className="site-eyebrow">How it works</span>
          <h2 className="site-h2 site-how__title">
            Four steps, one afternoon.
          </h2>
          <div className="site-how__steps">
            {STEPS.map(([number, title, body]) => (
              <div key={number} className="site-step">
                <span className="site-step__number">{number}</span>
                <h3 className="site-step__title">{title}</h3>
                <p className="site-step__body">{body}</p>
              </div>
            ))}
          </div>
          <p className="site-how__languages">
            Built multilingual from day one — it works in any language.
          </p>
        </div>
      </section>

      <section className="site-safety">
        <div className="site-container site-split site-safety__grid">
          <div>
            <span className="site-eyebrow">Safety net</span>
            <h2 className="site-h2 site-safety__title">
              If our AI ever slows down or fails, shoppers instantly get your
              store&apos;s normal search.
            </h2>
          </div>
          <div className="site-safety__side">
            <p className="site-safety__lead">No error states, ever.</p>
            <p className="site-safety__body">
              We read your catalog — we never write to it.
            </p>
          </div>
        </div>
      </section>

      <section id="proof" className="site-proof">
        <div className="site-container site-proof__grid">
          <div>
            <div className="site-proof__eyebrow-row">
              <span className="site-eyebrow">Proof, not vibes</span>
              <Badge tone="outline">Sample data</Badge>
            </div>
            <h2 className="site-h2 site-proof__title">
              Every order traced to the words that made it.
            </h2>
            <p className="site-proof__body">
              Search-attributed revenue sits next to your existing Shopify
              numbers. Zero-result searches come with the catalogue gaps that
              caused them.
            </p>
            <p className="site-proof__note">
              Numbers shown are sample data from a demo catalogue, not a
              customer result.
            </p>
            <div className="site-proof__cta">
              <Button variant="secondary" href={SITE_ROUTES.howItWorks}>
                Read the attribution method
              </Button>
            </div>
          </div>
          <div className="site-proof__stats">
            <div className="site-proof__stat-wide">
              <StatCard
                tone="inverse"
                label="Search-attributed revenue"
                value="₪128,400"
                delta="18.4%"
                trend="up"
                note="Illustrative · sample store, 30 days"
              />
            </div>
            <StatCard
              label="Attributed orders"
              value="1,284"
              delta="6.1%"
              trend="up"
              spark={[8, 11, 9, 14, 17, 15, 21]}
            />
            <StatCard
              label="Search → order rate"
              value="7.9%"
              delta="1.2pt"
              trend="up"
              note="Illustrative figures"
            />
            <StatCard
              label="Zero-result searches"
              value="37"
              delta="12%"
              trend="down"
            />
          </div>
        </div>
      </section>

      <section id="pricing" className="site-band site-band--top site-pricing">
        <div className="site-container">
          <div className="site-pricing__head">
            <span className="site-eyebrow">Pricing</span>
            <h2 className="site-h2 site-pricing__title">
              Priced against the revenue it returns.
            </h2>
            <p className="site-pricing__lede">
              Every plan includes attribution reporting, the classic-search
              fallback, and a 14-day trial.
            </p>
          </div>
          <div className="site-pricing__tiers">
            <PricingTiers />
          </div>
          <div className="site-pricing__notes">
            <div className="site-pricing__note site-pricing__note--wide">
              <p className="site-pricing__note-lead">
                Classic keyword searches: always unlimited, always free.
              </p>
              <p className="site-pricing__note-body">
                Only AI searches count against your monthly allowance.
              </p>
            </div>
            <div className="site-pricing__note site-pricing__note--mid">
              <span className="site-eyebrow">Over your allowance</span>
              <p className="site-pricing__note-body">
                $2 per additional 1,000 AI searches. No hard cut-off.
              </p>
            </div>
            <div className="site-pricing__note site-pricing__note--narrow">
              <span className="site-eyebrow">Bigger catalogue</span>
              <p className="site-pricing__note-body">
                Larger catalog?{" "}
                <a href="#pricing" className="site-link-accent">
                  Talk to us.
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="site-closer">
        <div className="site-container site-split site-closer__grid">
          <h2 className="site-h2 site-closer__title">
            Let your shoppers write the sentence.
          </h2>
          <div className="site-closer__side">
            <div className="site-actions">
              <Button size="lg" href={SITE_ROUTES.demo}>
                {TRY_CTA_LABEL}
              </Button>
              <Button size="lg" variant="secondary" href={SITE_ROUTES.demo}>
                Try the live demo
              </Button>
            </div>
            <p className="site-closer__note">
              14-day trial · installs in under 10 minutes · no theme code.
            </p>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
