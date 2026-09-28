/**
 * The marketing site's URLs and static assets, named once so the nav, the
 * footer, and every page link agree. The playground itself is `/try`; the
 * design export's separate "demo" page is not ported, because /try is the
 * demo.
 */
export const SITE_ROUTES = {
  home: "/",
  about: "/about",
  howItWorks: "/how-it-works",
  pricing: "/pricing",
  faq: "/faq",
  privacy: "/privacy",
  terms: "/terms",
  demo: "/try",
} as const;

/** Exported from the design kit into `public/site/`. */
export const SITE_ASSETS = {
  wordmark: "/site/logo-wordmark.svg",
  placeholder: (n: 1 | 2 | 3 | 4 | 5 | 6) =>
    `/site/placeholder/garment-0${n}.svg`,
} as const;
