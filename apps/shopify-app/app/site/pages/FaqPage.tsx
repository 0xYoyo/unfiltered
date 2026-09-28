import type { ReactNode } from "react";

import { Button } from "../components/Button";
import { SitePage } from "../components/SitePage";
import { SITE_ROUTES } from "../paths";

const QUESTIONS: [string, ReactNode][] = [
  [
    "How long does setup take?",
    "Install to your first working AI search in under 10 minutes. Indexing runs in the background — about 20 minutes for 5,000 products — and you can watch it finish in the app.",
  ],
  [
    "Will it work with my theme?",
    "Any Online Store 2.0 theme, via a theme app extension — no template edits and no code from you. Heavily customised or vintage themes may need a one-line block placement; we do that with you on a call, at no cost.",
  ],
  [
    "Does it replace my theme's search?",
    "It sits in front of it. Your theme's search stays installed and stays working — we use it as the fallback. You can turn Unfiltered off in one click and the storefront returns to exactly what it was.",
  ],
  [
    "Do I have to keep my filters?",
    "Your choice. Most stores keep the filter sidebar on collection pages and let search carry the sentences. Nothing about your collections or filter setup is changed by installing.",
  ],
  [
    "What data do you read?",
    "Products, variants, collections and product images, plus order line items for revenue attribution. We request read scopes only. We never write to your catalogue, never edit tags, never touch theme files.",
  ],
  [
    "Do you read customer data?",
    "No customer names, emails or addresses. Attribution works from an anonymous session identifier joined to order line items. Shopper queries are stored as text without any personal identifier.",
  ],
  [
    "How fast is it?",
    "Keyword queries return in about 40ms. Sentence queries typically land in 500–700ms. The search box itself adds roughly 12KB to your storefront and loads after your theme's own assets.",
  ],
  [
    "What if the AI goes down?",
    "If our AI ever slows down or fails, shoppers instantly get your store's normal search. No error states, ever. Every fallback is logged in your admin with its reason, and fallbacks never count as AI searches.",
  ],
  [
    "What happens if I uninstall?",
    "The search box disappears with the app and your theme's search takes over immediately. Billing stops at the end of the period, and your index, query history and attribution data are deleted within 30 days. Ask us and we'll delete them sooner.",
  ],
  [
    "Which languages are supported?",
    "Built multilingual from day one — it works in any language.",
  ],
  [
    "What size store is this for?",
    "Fashion and apparel stores from roughly 500 products up. Below that, filters usually still work. Above 20,000, write to us and we'll size a plan.",
  ],
  [
    "How do I reach support?",
    <>
      Email{" "}
      <a href="mailto:support@unfiltered.example" className="site-link-accent">
        support@unfiltered.example
      </a>
      . One working day on Rail and Studio, same working day on Atelier. A
      person who knows the product answers, not a queue.
    </>,
  ],
];

export function FaqPage() {
  return (
    <SitePage>
      <section className="site-faq__intro">
        <div className="site-faq__inner">
          <span className="site-eyebrow">FAQ</span>
          <h1 className="site-faq__title">Questions merchants actually ask.</h1>
          <p className="site-faq__lede">
            Billing details live on the{" "}
            <a href={SITE_ROUTES.pricing} className="site-link-accent">
              pricing page
            </a>
            . Everything else is here.
          </p>
        </div>
      </section>

      <section className="site-faq__body">
        <div className="site-faq__inner">
          <dl className="site-qa">
            {QUESTIONS.map(([question, answer]) => (
              <div key={question} className="site-qa__row site-qa__row--faq">
                <dt className="site-qa__q">{question}</dt>
                <dd className="site-qa__a">{answer}</dd>
              </div>
            ))}
          </dl>
          <div className="site-actions site-faq__actions">
            <Button href={SITE_ROUTES.pricing}>See pricing</Button>
            <Button variant="secondary" href="mailto:hello@unfiltered.example">
              Ask us directly
            </Button>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
