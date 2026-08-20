import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";

import db from "../db.server";
import { PlaygroundPage } from "../playground/PlaygroundPage";
import { CatalogNotFound } from "../playground/components/CatalogNotFound";
import {
  fixtureCatalog,
  playgroundFixturesEnabled,
} from "../playground/fixture-mode.server";
import {
  getPlaygroundStrings,
  resolveChromeLocale,
  type PlaygroundLocale,
} from "../playground/strings";

import "../playground/tokens.css";
import "../playground/playground.css";

/**
 * The store-preload page (YOY-94): the same playground, pointed at one
 * store's preloaded public catalog, on a link that can be shared.
 *
 * "Here is YOUR catalog answering human questions" is the whole pitch, so
 * the page is visibly the store's — and visibly ONLY by naming it. P-7
 * forbids per-store theming: no logo, no colours, no bespoke copy. Every
 * search request carries `catalog=<slug>`, and nothing else about the page
 * changes.
 *
 * The page is `noindex`: these links go out one at a time in outreach, and a
 * search engine indexing a demo of somebody else's catalog helps nobody. `/`
 * stays indexable.
 */

interface StoreCatalog {
  name: string;
  productCount: number;
}

async function findCatalog(slug: string): Promise<StoreCatalog | null> {
  if (playgroundFixturesEnabled()) {
    const fixture = fixtureCatalog(slug);
    return fixture === null
      ? null
      : { name: fixture.name, productCount: fixture.productCount };
  }
  return db.playgroundCatalog.findUnique({
    where: { slug },
    select: { name: true, productCount: true },
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const slug = params.slug ?? "";
  const locale = resolveChromeLocale(
    url.searchParams,
    request.headers.get("Accept-Language"),
  );

  const catalog = await findCatalog(slug);
  if (catalog === null) {
    // A real 404 status, rendered by the ErrorBoundary below as a designed
    // page in the playground's own shell — a shared link outlives the
    // catalog it pointed at, and that is not an error to shout about.
    throw new Response(null, { status: 404 });
  }

  return {
    locale,
    pathname: url.pathname,
    slug,
    store: catalog,
    initialQuery: url.searchParams.get("query") ?? "",
    detailsOpen: url.searchParams.get("details") === "1",
  };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const strings = getPlaygroundStrings(
    (data?.locale ?? "en") as PlaygroundLocale,
  );
  return [
    {
      title:
        data === undefined
          ? strings.pageTitle
          : strings.storeTitle.replace("{name}", data.store.name),
    },
    { name: "description", content: strings.metaDescription },
    { name: "robots", content: "noindex" },
  ];
};

export default function StorePreloadRoute() {
  const { locale, pathname, slug, store, initialQuery, detailsOpen } =
    useLoaderData<typeof loader>();

  return (
    <PlaygroundPage
      locale={locale}
      pathname={pathname}
      initialQuery={initialQuery}
      detailsOpen={detailsOpen}
      catalog={slug}
      store={store}
    />
  );
}

/**
 * Unknown slug. The chrome language is not available here — the loader threw
 * before resolving it — so this reads it from the URL alone, which is the
 * part of the request an error page can still trust.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const locale: PlaygroundLocale =
    typeof document !== "undefined" &&
    new URLSearchParams(document.location.search).get("lang") === "he"
      ? "he"
      : "en";
  const strings = getPlaygroundStrings(locale);

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="playground">
        <header className="header shell">
          <span className="productName">{strings.productName}</span>
        </header>
        <main className="main shell">
          <CatalogNotFound strings={strings} />
        </main>
        <footer className="footer shell">{strings.footerNote}</footer>
      </div>
    );
  }

  throw error;
}
