import { SITE_ROUTES, TRY_CTA_LABEL } from "../paths";

import { Button, type ButtonVariant } from "./Button";
import { Wordmark } from "./Wordmark";

/**
 * The nav (and the footer) are English-only site chrome, so they pin
 * `dir="ltr"` even on the Hebrew playground at `/try?lang=he` — mirrored
 * English strands its punctuation (DESIGN X-7).
 *
 * The sticky top bar: the one place the site uses transparency and blur
 * (86% ivory + 10px blur, readme "Backgrounds"). Below 780px the text links
 * drop out and only the wordmark and the call to action remain. The call to
 * action is a link to /try (YOY-156 AC-3): no install can be started yet.
 *
 * `installVariant` is "secondary" on /try: there the playground's search
 * button is the page's one accent fill (DESIGN P-2), so the call to action
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
        <Wordmark className="site-nav__logo" />
      </a>
      <nav className="site-nav__links">
        <span className="site-nav__text-links">
          <a href={SITE_ROUTES.howItWorks}>How it works</a>
          <a href={SITE_ROUTES.pricing}>Pricing</a>
          <a href={SITE_ROUTES.demo}>Demo</a>
          <a href={SITE_ROUTES.faq}>FAQ</a>
        </span>
        <span className="site-nav__install">
          <Button size="sm" variant={installVariant} href={SITE_ROUTES.demo}>
            {TRY_CTA_LABEL}
          </Button>
        </span>
      </nav>
    </header>
  );
}
