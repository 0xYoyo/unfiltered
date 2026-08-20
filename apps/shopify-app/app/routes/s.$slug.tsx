import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  isRouteErrorResponse,
  useLocation,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import db from "../db.server";
import { PlaygroundPage } from "../playground/PlaygroundPage";
import { CatalogNotFound } from "../playground/components/CatalogNotFound";
import { LanguageToggle } from "../playground/components/LanguageToggle";
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
 * Unknown slug. This route's own loader threw, so its data is gone — but the
 * ROOT loader already resolved the chrome language for this request (it runs
 * for every playground path, `?lang=` then `Accept-Language`), and that is
 * what stamped `<html lang dir>`. Reading it from there keeps the server and
 * the client rendering the same words: deriving the language from
 * `document` instead would render English on the server inside an
 * `<html lang="he">`, then flip to Hebrew on hydration — the first-frame
 * flicker YOY-92 resolved the language server-side to avoid — and would
 * never honour `Accept-Language` at all.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const root = useRouteLoaderData("root") as
    | { lang: string; dir: string }
    | undefined;
  const locale: PlaygroundLocale = root?.lang === "he" ? "he" : "en";
  const strings = getPlaygroundStrings(locale);

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="playground">
        {/* The same shell as `/` (AC-1), language toggle included: a reader
            who landed here in the wrong language must still be able to
            switch, and a shorter header would not be the same shell. */}
        <header className="header shell">
          <span className="productName">{strings.productName}</span>
          <LanguageToggle
            locale={locale}
            strings={strings}
            pathname={location.pathname}
            query=""
            detailsOpen={false}
          />
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
