import type { LoaderFunctionArgs } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import {
  localeDirection,
  ownedPageKind,
  resolveChromeLocale,
} from "./playground/strings";

/**
 * `<html lang>` and `<html dir>` are resolved server-side (YOY-92 AC-3) so
 * the Hebrew chrome is right in the first byte — a client-side flip would
 * show one frame of LTR before mirroring.
 *
 * Only the playground's own paths participate — `/try` and the
 * store-preload pages at `/s/<slug>`. The marketing site is English and
 * LTR, and the merchant admin is English-only and LTR by design (DESIGN
 * A-4), so a Hebrew browser must not flip Polaris into RTL just by visiting.
 *
 * The owned/not-owned split decides the font source (YOY-96 AC-13): the
 * Shopify-CDN Inter stylesheet is Polaris's, for the admin; the owned pages
 * — the marketing site and the playground — self-host their families, Latin
 * and Hebrew in each (playground/fonts.css), and load nothing from a
 * third-party font CDN, so they stay self-contained.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const kind = ownedPageKind(url.pathname);
  if (kind !== "playground") {
    return { lang: "en", dir: "ltr" as const, owned: kind === "site" };
  }
  const locale = resolveChromeLocale(
    url.searchParams,
    request.headers.get("Accept-Language"),
  );
  return { lang: locale, dir: localeDirection(locale), owned: true };
};

export default function App() {
  const { lang, dir, owned } = useLoaderData<typeof loader>();

  return (
    <html lang={lang} dir={dir}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {owned ? null : (
          <>
            <link rel="preconnect" href="https://cdn.shopify.com/" />
            <link
              rel="stylesheet"
              href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
            />
          </>
        )}
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
