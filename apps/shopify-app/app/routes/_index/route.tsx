import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";

import { PlaygroundPage } from "../../playground/PlaygroundPage";
import {
  getPlaygroundStrings,
  resolveChromeLocale,
  type PlaygroundLocale,
} from "../../playground/strings";

import "../../playground/tokens.css";
import "../../playground/playground.css";

/**
 * `GET /` is the playground (YOY-92 AC-1) — Unfiltered's only owned page,
 * and the first thing anyone evaluating the product sees. The Shopify
 * template's marketing copy and login form are gone; the `?shop=` redirect
 * into the embedded admin is not, because that is how Shopify opens the app.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  const locale = resolveChromeLocale(
    url.searchParams,
    request.headers.get("Accept-Language"),
  );

  return {
    locale,
    pathname: url.pathname,
    // Carried across a language switch so the toggle does not clear a typed
    // query (AC-3).
    initialQuery: url.searchParams.get("query") ?? "",
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
  const { locale, pathname, initialQuery } = useLoaderData<typeof loader>();

  return (
    <PlaygroundPage
      locale={locale}
      pathname={pathname}
      initialQuery={initialQuery}
    />
  );
}
