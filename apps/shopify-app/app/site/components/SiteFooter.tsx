import { SITE_ASSETS, SITE_ROUTES } from "../paths";

export function SiteFooter() {
  return (
    <footer className="site-footer site-chrome" dir="ltr" lang="en">
      <div className="site-footer__grid">
        <div>
          <img
            src={SITE_ASSETS.wordmark}
            alt="Unfiltered"
            className="site-footer__logo"
          />
          <p className="site-footer__blurb">
            Search for fashion stores. Works natively with Shopify and on any
            online store. Built multilingual from day one.
          </p>
        </div>
        <div>
          <div className="site-eyebrow">Product</div>
          <ul className="site-footer__list">
            <li>
              <a href={SITE_ROUTES.howItWorks}>How it works</a>
            </li>
            <li>
              <a href={SITE_ROUTES.pricing}>Pricing</a>
            </li>
            <li>
              <a href={SITE_ROUTES.demo}>Live demo</a>
            </li>
            <li>
              <a href={`${SITE_ROUTES.home}#proof`}>Attribution</a>
            </li>
          </ul>
        </div>
        <div>
          <div className="site-eyebrow">Company</div>
          <ul className="site-footer__list">
            <li>
              <a href={SITE_ROUTES.about}>About</a>
            </li>
            <li>
              <a href={SITE_ROUTES.faq}>FAQ</a>
            </li>
            <li>
              <a href="mailto:hello@unfiltered.example">
                hello@unfiltered.example
              </a>
            </li>
          </ul>
        </div>
        <div>
          <div className="site-eyebrow">Legal</div>
          <ul className="site-footer__list">
            <li>
              <a href={SITE_ROUTES.privacy}>Privacy policy</a>
            </li>
            <li>
              <a href={SITE_ROUTES.terms}>Terms of service</a>
            </li>
          </ul>
        </div>
      </div>
      <div className="site-footer__base">
        <p>© 2026 Unfiltered.</p>
        <p>Not affiliated with Shopify. Sample figures shown throughout.</p>
      </div>
    </footer>
  );
}
