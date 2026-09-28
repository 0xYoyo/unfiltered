import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { PlaygroundPage } from "../playground/PlaygroundPage";
import {
  getPlaygroundStrings,
  resolveChromeLocale,
  type PlaygroundLocale,
} from "../playground/strings";
import { SiteFooter } from "../site/components/SiteFooter";
import { SiteNav } from "../site/components/SiteNav";

import "../playground/fonts.css";
import "../playground/tokens.css";
import "../playground/playground.css";
import "../site/site.css";

/**
 * `GET /try` is the playground (YOY-92 AC-1) — the page anyone evaluating
 * the product searches on — framed by the marketing site's nav and footer,
 * so site and playground read as one site. It moved here from `/` when the
 * marketing site took `/`; the page itself is unchanged.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const locale = resolveChromeLocale(
    url.searchParams,
    request.headers.get("Accept-Language"),
  );

  return {
    locale,
    pathname: url.pathname,
    // Carried across a language switch so the toggle does not clear a typed
    // query (YOY-92 AC-3).
    initialQuery: url.searchParams.get("query") ?? "",
    // The engine-details panel is opt-in and its state IS the URL, so it
    // survives a reload and can be shared as a link (YOY-93 AC-5).
    detailsOpen: url.searchParams.get("details") === "1",
  };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const strings = getPlaygroundStrings(
    (data?.locale ?? "en") as PlaygroundLocale,
  );
  return [
    { title: strings.pageTitle },
    { name: "description", content: strings.metaDescription },
  ];
};

export default function PlaygroundRoute() {
  const { locale, pathname, initialQuery, detailsOpen } =
    useLoaderData<typeof loader>();

  return (
    <>
      <SiteNav />
      <PlaygroundPage
        locale={locale}
        pathname={pathname}
        initialQuery={initialQuery}
        detailsOpen={detailsOpen}
      />
      <SiteFooter />
    </>
  );
}
