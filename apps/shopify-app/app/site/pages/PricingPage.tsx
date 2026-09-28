import { PricingTiers } from "../components/PricingCard";
import { SitePage } from "../components/SitePage";
import { SITE_ROUTES } from "../paths";

const BILLING = [
  [
    "What the trial includes",
    "14 days, on any plan, with 1,000 AI searches included. A card is required to start it — Shopify handles billing, and nothing is charged until day 15.",
  ],
  [
    "What counts as an AI search",
    "One shopper query that we send to a model — a sentence, a question, or a follow-up refinement. Short keyword queries handled by the index don't count. Neither do repeated identical queries within a session, chip removals, pagination, or fallbacks.",
  ],
  [
    "Overage",
    "$2 per additional 1,000 AI searches, billed with your next Shopify invoice. You can set an overage ceiling in settings; we email you at 80% and 100% of the allowance either way.",
  ],
  [
    "What happens at the cap",
    "Nothing breaks. If you've capped overage and hit it, AI understanding pauses and every query is served by classic keyword search — the same silent fallback that covers a slow model. Shoppers still get results; you're never billed past your ceiling.",
  ],
  [
    "Cancelling",
    "Cancel or switch plans any time from the app, or just uninstall. Billing stops at the end of the current period, and your search index is deleted within 30 days. Your catalogue is untouched, because we never wrote to it.",
  ],
] as const;

export function PricingPage() {
  return (
    <SitePage ground="white">
      <section className="site-pricing-page">
        <div className="site-container">
          <div className="site-pricing__head">
            <span className="site-eyebrow">Pricing</span>
            <h1 className="site-pricing-page__title">
              Priced against the revenue it returns.
            </h1>
            <p className="site-pricing-page__lede">
              Every plan includes attribution reporting, the classic-search
              fallback, and a 14-day trial.
            </p>
          </div>
          <div className="site-pricing__tiers site-pricing-page__tiers">
            <PricingTiers />
          </div>
          <div className="site-pricing-page__notes">
            <div>
              <p className="site-pricing-page__note-lead">
                Classic keyword searches: always unlimited, always free.
              </p>
              <p className="site-pricing-page__note-body site-pricing-page__note-body--wide">
                Only AI searches count against your monthly allowance.
              </p>
            </div>
            <div>
              <span className="site-eyebrow">Over your allowance</span>
              <p className="site-pricing-page__note-body">
                $2 per additional 1,000 AI searches. No hard cut-off.
              </p>
            </div>
            <div>
              <span className="site-eyebrow">Bigger catalogue</span>
              <p className="site-pricing-page__note-body">
                Over 20,000 products?{" "}
                <a
                  href="mailto:hello@unfiltered.example"
                  className="site-link-accent"
                >
                  Talk to us.
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="site-billing">
        <div className="site-billing__inner">
          <span className="site-eyebrow">Billing questions</span>
          <h2 className="site-h2 site-billing__title">
            What you are actually paying for.
          </h2>
          <dl className="site-qa site-billing__list">
            {BILLING.map(([question, answer]) => (
              <div key={question} className="site-qa__row">
                <dt className="site-qa__q">{question}</dt>
                <dd className="site-qa__a">{answer}</dd>
              </div>
            ))}
          </dl>
          <p className="site-billing__more">
            More questions?{" "}
            <a href={SITE_ROUTES.faq} className="site-link-accent">
              Read the full FAQ.
            </a>
          </p>
        </div>
      </section>
    </SitePage>
  );
}
