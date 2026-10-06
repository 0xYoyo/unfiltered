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

/**
 * The label every former trial and install button carries (YOY-156 AC-3):
 * neither a trial nor an install can be started yet, and /try can.
 */
export const TRY_CTA_LABEL = "Try it on a real catalog";

/** Exported from the design kit into `public/site/`. */
export const SITE_ASSETS = {
  placeholder: (n: 1 | 2 | 3 | 4 | 5 | 6) =>
    `/site/placeholder/garment-0${n}.svg`,
} as const;
