import { LegalDocument, LegalSection } from "../components/LegalDocument";
import { SITE_ROUTES } from "../paths";

const SECTIONS = [
  [
    "1. Agreement",
    "Installing the app from the Shopify App Store forms an agreement between the store owner (“you”) and Unfiltered. Shopify's own terms also apply to the transaction. [Insert legal entity and governing agreement structure.]",
  ],
  [
    "2. The service",
    "We provide a hosted search service for your storefront, including a search index built from your catalogue, interpretation of shopper queries, a fallback to your theme's native search, and attribution reporting. Features may change as the product develops; we will not remove a materially relied-upon feature without notice.",
  ],
  [
    "3. Your account and store data",
    "You grant us read-only access to the catalogue and order data needed to operate the service. You retain all rights in your catalogue, product copy and imagery. We do not write to your store and do not modify your theme.",
  ],
  [
    "4. Fees, trial and overage",
    "Plans are billed monthly through Shopify. The trial runs 14 days and includes 1,000 AI searches; a card is required to begin it. AI searches beyond your plan allowance are billed at $2 per additional 1,000. Classic keyword searches are unlimited and not billed. Taxes are your responsibility where applicable.",
  ],
  [
    "5. Acceptable use",
    "No reselling or reverse engineering of the service, no automated querying beyond ordinary storefront traffic, no use for unlawful goods, and no attempt to extract another merchant's data. We may rate-limit or suspend abusive traffic.",
  ],
  [
    "6. Availability",
    "The service is provided on a commercially reasonable availability basis. When AI interpretation is unavailable, queries fall back to your store's native search. [Insert SLA and credit terms if offered on Atelier.]",
  ],
  [
    "7. Intellectual property",
    "We own the app, models, indexes and interfaces we build. You own your data. We may use aggregated, de-identified usage statistics to improve the service.",
  ],
  [
    "8. Term, cancellation and uninstall",
    "Either party may end the agreement at any time. Cancelling or uninstalling stops billing at the end of the current period. On uninstall, your index, query history and attribution data are deleted within 30 days, and your storefront reverts to your theme's own search.",
  ],
  [
    "9. Disclaimers",
    "Search results and attribution figures are estimates produced by software and are provided without warranty of accuracy or of any commercial outcome. [Insert statutory disclaimer language.]",
  ],
  [
    "10. Liability",
    "[Liability cap, exclusion of indirect loss, and carve-outs to be set by counsel — typically capped at fees paid in the preceding 12 months.]",
  ],
  [
    "11. Governing law and disputes",
    "[Governing law, venue, and dispute-resolution mechanism to be inserted.]",
  ],
  [
    "12. Changes to these terms",
    "We will post revisions here and email merchants at least 30 days before material changes take effect. Continued use after that date constitutes acceptance.",
  ],
] as const;

export function TermsPage() {
  return (
    <LegalDocument
      title="Terms of service"
      standfirst="A structural draft of the agreement between Unfiltered and a merchant installing the app. Not reviewed by counsel, not in force."
      closing={
        <>
          Draft — legal review pending. See also the{" "}
          <a href={SITE_ROUTES.privacy} className="site-link-accent">
            privacy policy
          </a>
          .
        </>
      }
    >
      {SECTIONS.map(([heading, body]) => (
        <LegalSection key={heading} heading={heading}>
          <p className="site-legal__p">{body}</p>
        </LegalSection>
      ))}
    </LegalDocument>
  );
}
