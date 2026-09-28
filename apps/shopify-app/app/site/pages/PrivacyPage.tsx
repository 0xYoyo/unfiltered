import { LegalDocument, LegalSection } from "../components/LegalDocument";
import { SITE_ROUTES } from "../paths";

function Code({ children }: { children: string }) {
  return <code className="site-legal__code">{children}</code>;
}

export function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy policy"
      standfirst="This is a structural draft covering what a Shopify app of this kind must disclose. It has not been reviewed by counsel and is not yet binding on anyone."
      closing={
        <>
          Draft — legal review pending. Bracketed passages mark decisions that
          need counsel before publication. See also the{" "}
          <a href={SITE_ROUTES.terms} className="site-link-accent">
            terms of service
          </a>
          .
        </>
      }
    >
      <LegalSection heading="1. Who we are">
        <p className="site-legal__p">
          Unfiltered (“we”, “us”) provides a search application that works
          natively with Shopify and on any online store. Our contact for privacy
          matters is{" "}
          <a
            href="mailto:privacy@unfiltered.example"
            className="site-link-accent"
          >
            privacy@unfiltered.example
          </a>
          . [Legal entity name, registered address and, where required, EU/UK
          representative to be inserted.]
        </p>
      </LegalSection>
      <LegalSection heading="2. Roles">
        <p className="site-legal__p">
          For catalogue and order data drawn from a merchant&apos;s store, the
          merchant is the controller and we act as processor on their
          instructions. For merchant account and billing records we act as
          controller. [Confirm characterisation per jurisdiction.]
        </p>
      </LegalSection>
      <LegalSection heading="3. Data we collect">
        <ul className="site-legal__list">
          <li>
            <strong>Catalogue data.</strong> Products, variants, collections,
            prices, inventory status and product images, read via the Shopify
            Admin API.
          </li>
          <li>
            <strong>Order data.</strong> Order line items, totals and
            timestamps, used solely to attribute revenue to searches.
          </li>
          <li>
            <strong>Search events.</strong> Query text, understood constraints,
            results shown, clicks, and an anonymous session identifier.
          </li>
          <li>
            <strong>Merchant account data.</strong> Shop domain, plan, contact
            email, and billing records held by Shopify.
          </li>
          <li>
            <strong>Technical data.</strong> IP address, user agent and request
            logs, retained short-term for security and abuse prevention.
          </li>
        </ul>
        <p className="site-legal__p site-legal__p--after-list">
          We do not request or store shopper names, email addresses, shipping
          addresses or payment details. Access to the Shopify API is read-only;
          we never write to a merchant&apos;s catalogue.
        </p>
      </LegalSection>
      <LegalSection heading="4. Why we process it">
        <p className="site-legal__p">
          To operate the search service, to build and maintain the search index,
          to produce attribution reporting for the merchant, to bill correctly,
          and to secure the service. Legal bases: performance of contract,
          legitimate interests, and the merchant&apos;s instructions as
          controller. [Confirm per-purpose mapping.]
        </p>
      </LegalSection>
      <LegalSection heading="5. Sub-processors">
        <p className="site-legal__p">
          We use third-party infrastructure and model providers to host the
          service and to interpret queries. Query text may be sent to a model
          provider for interpretation; it is not used to train third-party
          models. [Insert current sub-processor list, locations, and DPA
          references.]
        </p>
      </LegalSection>
      <LegalSection heading="6. International transfers">
        <p className="site-legal__p">
          Data may be processed outside your country, including in the United
          States and the European Union. Transfers rely on Standard Contractual
          Clauses or an equivalent mechanism. [Insert regions and safeguards.]
        </p>
      </LegalSection>
      <LegalSection heading="7. Retention and deletion">
        <p className="site-legal__p">
          Search events are retained for 24 months in aggregate reporting. On
          uninstall, we receive Shopify&apos;s <Code>app/uninstalled</Code>{" "}
          webhook and delete the store&apos;s index, query history and
          attribution data within 30 days. Merchants may request earlier
          deletion at any time.
        </p>
      </LegalSection>
      <LegalSection heading="8. Mandatory Shopify webhooks">
        <p className="site-legal__p">
          We implement the required privacy webhooks —{" "}
          <Code>customers/data_request</Code>, <Code>customers/redact</Code> and{" "}
          <Code>shop/redact</Code>. Because we hold no shopper identifiers, a
          customer redaction request results in deletion of any session-linked
          search events we can associate with the request.
        </p>
      </LegalSection>
      <LegalSection heading="9. Your rights">
        <p className="site-legal__p">
          Under the GDPR, UK GDPR, CCPA/CPRA and comparable laws you may request
          access, correction, deletion, restriction, portability, or object to
          processing. Shoppers should contact the merchant whose store they
          used; we will assist that merchant as processor. [Insert response
          timelines and appeal route.]
        </p>
      </LegalSection>
      <LegalSection heading="10. Security">
        <p className="site-legal__p">
          Encryption in transit and at rest, least-privilege access, audit
          logging, and per-store data isolation. [Insert incident-response
          commitment and notification window.]
        </p>
      </LegalSection>
      <LegalSection heading="11. Cookies">
        <p className="site-legal__p">
          The storefront search uses a first-party session identifier to connect
          a search to a resulting order. No advertising or cross-site tracking
          cookies are set. [Insert cookie table and lifetimes.]
        </p>
      </LegalSection>
      <LegalSection heading="12. Changes">
        <p className="site-legal__p">
          We will post revisions here and notify merchants by email before
          material changes take effect.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
