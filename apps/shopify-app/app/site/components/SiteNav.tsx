import { SITE_ASSETS, SITE_ROUTES } from "../paths";

import { Button, type ButtonVariant } from "./Button";

/**
 * The nav (and the footer) are English-only site chrome, so they pin
 * `dir="ltr"` even on the Hebrew playground at `/try?lang=he` — mirrored
 * English strands its punctuation (DESIGN X-7).
 *
 * The sticky top bar: the one place the site uses transparency and blur
 * (86% ivory + 10px blur, readme "Backgrounds"). Below 780px the text links
 * drop out and only the wordmark and the install button remain.
 *
 * `installVariant` is "secondary" on /try: there the playground's search
 * button is the page's one accent fill (DESIGN P-2), so the install button
 * gives up its red.
 */
export function SiteNav({
  installVariant = "primary",
}: {
  installVariant?: ButtonVariant;
} = {}) {
  return (
    <header className="site-nav site-chrome" dir="ltr" lang="en">
      <a
        href={SITE_ROUTES.home}
        className="site-nav__home"
        aria-label="Unfiltered home"
      >
        <img
          src={SITE_ASSETS.wordmark}
          alt="Unfiltered"
          className="site-nav__logo"
        />
      </a>
      <nav className="site-nav__links">
        <span className="site-nav__text-links">
          <a href={SITE_ROUTES.howItWorks}>How it works</a>
          <a href={SITE_ROUTES.pricing}>Pricing</a>
          <a href={SITE_ROUTES.demo}>Demo</a>
          <a href={SITE_ROUTES.faq}>FAQ</a>
        </span>
        <span title="Coming to the App Store" className="site-nav__install">
          <Button size="sm" variant={installVariant} disabled>
            Add to Shopify
          </Button>
        </span>
      </nav>
    </header>
  );
}
