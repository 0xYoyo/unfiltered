import { SITE_ROUTES, TRY_CTA_LABEL } from "../paths";

import { Badge } from "./Badge";
import { Button } from "./Button";

/**
 * The design export's PricingCard. The featured plan takes the 1px ink
 * border, `--shadow-2`, and the page's one primary button (readme
 * "Corners and borders", "Shadows").
 */
export function PricingCard({
  name,
  price,
  period = "/ month",
  description,
  features,
  featured = false,
  badge,
  ctaLabel = TRY_CTA_LABEL,
  footnote,
}: {
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  featured?: boolean;
  badge?: string;
  ctaLabel?: string;
  footnote: string;
}) {
  return (
    <div className={`unf-pricing${featured ? " unf-pricing--featured" : ""}`}>
      <div className="unf-pricing__head">
        <span className="unf-pricing__name">{name}</span>
        {badge ? (
          <Badge tone={featured ? "accent" : "neutral"}>{badge}</Badge>
        ) : null}
      </div>
      <div className="unf-pricing__price">
        <span className="unf-pricing__amount">{price}</span>
        <span className="unf-pricing__period">{period}</span>
      </div>
      <p className="unf-pricing__desc">{description}</p>
      <hr className="unf-pricing__rule" />
      <ul className="unf-pricing__features">
        {features.map((feature) => (
          <li key={feature}>
            <svg
              className="unf-pricing__tick"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 7.5 L5.5 11 L12 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Button
        variant={featured ? "primary" : "secondary"}
        block
        href={SITE_ROUTES.demo}
      >
        {ctaLabel}
      </Button>
      <span className="unf-pricing__foot">{footnote}</span>
    </div>
  );
}

const FOOTNOTE = "14-day free trial · card required · cancel anytime.";

/** The three tiers, as designed; the landing page and /pricing share them. */
export function PricingTiers() {
  return (
    <>
      <PricingCard
        name="Rail"
        price="$39"
        description="For a tight, well-tagged catalogue."
        features={[
          "10,000 AI searches / month",
          "Catalogs up to 1,000 products",
          "Attributed orders & revenue",
          "Classic-search fallback",
          "Email support",
        ]}
        footnote={FOOTNOTE}
      />
      <PricingCard
        name="Studio"
        price="$99"
        featured
        badge="Most popular"
        description="For stores doing real volume."
        features={[
          "50,000 AI searches / month",
          "Catalogs up to 5,000 products",
          "Everything in Rail",
          "Zero-result gap alerts",
        ]}
        footnote={FOOTNOTE}
      />
      <PricingCard
        name="Atelier"
        price="$249"
        description="For large, multi-brand catalogues."
        features={[
          "200,000 AI searches / month",
          "Catalogs up to 20,000 products",
          "Everything in Studio",
          "Priority support",
        ]}
        footnote={FOOTNOTE}
      />
    </>
  );
}
