import { SitePage } from "../components/SitePage";

export function AboutPage() {
  return (
    <SitePage fill>
      <section className="site-about">
        <div className="site-about__inner">
          <span className="site-eyebrow">About</span>
          <h1 className="site-about__title">
            We built the search box we kept wishing for.
          </h1>
          <div className="site-about__prose">
            <p>
              Every fashion store we worked with had the same gap. The catalogue
              was full of the right pieces, the shopper knew what she wanted,
              and the only way between the two was a sidebar of checkboxes that
              spoke a different language. “Elegant, not black, under ₪400, hides
              my belly” has no checkbox.
            </p>
            <p>
              So the product does one job: read the sentence, show its reading,
              and prove what it earned. It sits in front of the search your
              theme already has, and hands the query back the moment it
              can&apos;t do better.
            </p>
            <p>
              We only work on fashion and apparel. Clothes are described in
              fabric, fit, occasion and feel — vocabulary that a general-purpose
              search engine flattens. Staying in one category is what lets us
              get that vocabulary right, and it&apos;s why we&apos;d rather send
              a furniture store elsewhere than sell them something half-tuned.
            </p>
          </div>
          <div className="site-about__contacts">
            <div>
              <span className="site-eyebrow">Contact</span>
              <p className="site-about__contact">
                <a
                  href="mailto:hello@unfiltered.example"
                  className="site-link-accent"
                >
                  hello@unfiltered.example
                </a>
                <br />
                Placeholder address — real one at launch.
              </p>
            </div>
            <div>
              <span className="site-eyebrow">Support</span>
              <p className="site-about__contact">
                <a
                  href="mailto:support@unfiltered.example"
                  className="site-link-accent"
                >
                  support@unfiltered.example
                </a>
              </p>
            </div>
            <div>
              <span className="site-eyebrow">Status</span>
              <p className="site-about__contact">
                Pre-launch. Coming to the Shopify App Store.
              </p>
            </div>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
