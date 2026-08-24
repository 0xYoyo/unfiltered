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
  isPlaygroundPath,
  localeDirection,
  resolveChromeLocale,
} from "./playground/strings";

/**
 * `<html lang>` and `<html dir>` are resolved server-side (YOY-92 AC-3) so
 * the Hebrew chrome is right in the first byte — a client-side flip would
 * show one frame of LTR before mirroring.
 *
 * Only the playground's own paths participate — `/` and the store-preload
 * pages at `/s/<slug>`. The merchant admin is English-only and LTR by design
 * (DESIGN A-4), so a Hebrew browser must not flip Polaris into RTL just by
 * visiting.
 *
 * The same split decides the font source (YOY-96 AC-13): the Shopify-CDN
 * Inter stylesheet is Polaris's, for the admin; the playground self-hosts
 * its own Latin + Hebrew family (playground/fonts.css) and loads nothing
 * from a third-party font CDN, so its pages stay self-contained.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (!isPlaygroundPath(url.pathname)) {
    return { lang: "en", dir: "ltr" as const, playground: false };
  }
  const locale = resolveChromeLocale(
    url.searchParams,
    request.headers.get("Accept-Language"),
  );
  return { lang: locale, dir: localeDirection(locale), playground: true };
};

export default function App() {
  const { lang, dir, playground } = useLoaderData<typeof loader>();

  return (
    <html lang={lang} dir={dir}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {playground ? null : (
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
