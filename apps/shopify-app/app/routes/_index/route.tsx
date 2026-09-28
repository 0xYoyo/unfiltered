import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import { LandingPage } from "../../site/pages/LandingPage";

import "../../playground/fonts.css";
import "../../playground/tokens.css";
import "../../site/site.css";

/**
 * `GET /` is the marketing site's landing page; the playground lives at
 * `/try`. The `?shop=` redirect into the embedded admin stays HERE, on `/`,
 * because that is the URL Shopify opens the app on.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export const meta: MetaFunction = () => [
  { title: "Unfiltered — Your shoppers don't think in filters." },
];

export default function LandingRoute() {
  return <LandingPage />;
}
