import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ProxyChip,
  ProxyIntent,
  ProxyLabel,
} from "../search/proxy.server";
import type { PlaygroundSearchResponse } from "./api.server";
import type { PlaygroundCard } from "./components/Card";
import { ChipRow } from "./components/ChipRow";
import { EngineDetails } from "./components/EngineDetails";
import { ExampleQueries } from "./components/ExampleQueries";
import { LanguageToggle } from "./components/LanguageToggle";
import { NewSearch } from "./components/NewSearch";
import { ResultsGrid } from "./components/ResultsGrid";
import { SearchBar } from "./components/SearchBar";
import { StatusLine } from "./components/StatusLine";
import { StoreLine } from "./components/StoreLine";
import {
  PREVIEW_DEBOUNCE_MS,
  fetchPlaygroundLabels,
  searchPlayground,
  sendPlaygroundClick,
  type PlaygroundEngine,
  type RemovedChip,
} from "./search-client";
import {
  closeMatchesHeadingText,
  getPlaygroundStrings,
  type PlaygroundLocale,
} from "./strings";

/**
 * The playground page (YOY-92, extended by YOY-93 with the AI states).
 *
 * The shell is deliberately plain — header, hero bar, status line, grid —
 * because it is Unfiltered's only owned page and every element on it has to
 * earn its place (P-1, P-3). What YOY-93 adds is the part that shows the
 * difference: constraints rendered as removable chips (filters as OUTPUT),
 * refinement carried in the bar rather than a chat log, and an opt-in panel
 * that shows exactly what the engine understood.
 *
 * The held intent is the whole state model, and it is deliberately ONE
 * intent held in memory: each response's echoed intent replaces it, nothing
 * persists, and there is no transcript (NG-2, X-2). "New search" drops it.
 *
 * Engine v2 (YOY-150) holds a `carry` instead: the last submitted
 * response's text for the next search's `previousQuery`, in memory only
 * (AC-6). Every submitted search sends it; "New search", an example and the
 * second-reading chip start afresh without it (AC-5, AC-9).
 */

type Phase = "initial" | "loading" | "settled";

/** Results per page a submitted search asks for (YOY-146 AC-1). */
const PAGE_SIZE = 24;

/**
 * The further pages of the submitted search on screen (YOY-146): the exact
 * request that produced page 1, the next page to ask for, and how far the
 * whole order goes. Replaced by every new response; a page that lands for a
 * replaced one is dropped.
 */
interface PagingState {
  query: string;
  previousIntent: ProxyIntent | null;
  removeChip?: ProxyChip;
  /** The engine v2 removal list that produced page 1 (YOY-149). */
  removedChips?: readonly RemovedChip[];
  /** The `previousQuery` that produced page 1 (YOY-150). */
  previousQuery?: string;
  nextPage: number;
  shown: number;
  total: number;
  loading: boolean;
  /** A page failed: appending stops, the shown cards stay (AC-9). */
  stopped: boolean;
}

export function PlaygroundPage({
  locale,
  pathname,
  initialQuery,
  detailsOpen: initialDetailsOpen,
  catalog,
  store,
  engine,
}: {
  locale: PlaygroundLocale;
  pathname: string;
  initialQuery: string;
  detailsOpen: boolean;
  /**
   * The engine `/try?engine=` names (YOY-165 AC-1): every submitted
   * search, chip removal and page request of this page view carries it.
   * Absent means the server default.
   */
  engine?: PlaygroundEngine;
  /** Registry slug; every request on a preload page carries it (YOY-94). */
  catalog?: string;
  /** The preloaded store, when this is a `/s/<slug>` page. */
  store?: { name: string; productCount: number };
}) {
  const strings = getPlaygroundStrings(locale);

  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>("initial");
  const [response, setResponse] = useState<PlaygroundSearchResponse | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  // Cards appended from later pages (YOY-146 AC-6), below page 1's.
  const [more, setMore] = useState<PlaygroundCard[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagingRef = useRef<PagingState | null>(null);
  // Late labels (YOY-151 AC-8): the cards whose page answered with
  // `labelsPending` reserve their label line, and the labels endpoint's
  // answer lands here by product id — never re-ordering a card (AC-9).
  // `labelsGenRef` counts responses, so an answer for a replaced one drops.
  const [labelsPending, setLabelsPending] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lateLabels, setLateLabels] = useState<
    Record<string, ProxyLabel | null>
  >({});
  const labelsGenRef = useRef(0);
  // The searchId a click beacon may carry: the last SUBMITTED response's,
  // or null while the cards on screen belong to a keystroke preview. A
  // preview writes no SearchEvent row (YOY-68 AC-3), so its searchId is not
  // attributable and a beacon against it is a write nothing can join — the
  // widget nulls its own id on every preview for the same reason (YOY-96
  // AC-14, P-5 parity).
  const [attributableSearchId, setAttributableSearchId] = useState<
    string | null
  >(null);

  // The held intent: the last AI response's echoed intent, in memory only.
  const [heldIntent, setHeldIntent] = useState<ProxyIntent | null>(null);
  // Seeded from the URL by the loader, then owned here: toggling must not
  // navigate, or the answer the panel explains would be thrown away.
  const [detailsOpen, setDetailsOpen] = useState(initialDetailsOpen);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // One in-flight request at a time: a slower earlier response must never
  // overwrite a newer one (results replace, and only the newest wins).
  const requestRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The query text a submit has already answered. Setting `query` from a
  // submit (an example click) re-runs the preview effect on the next render,
  // which would schedule a preview that aborts the in-flight submitted
  // search 200ms later and replace a real AI answer with classic cards.
  const submittedQueryRef = useRef<string | null>(null);
  // Read inside `run` without making it a dependency: a keystroke must not
  // restart the debounce just because the held intent changed. Mirrored in
  // an effect rather than during render — a render may be discarded, and a
  // ref written from one would leak that discarded value.
  const heldIntentRef = useRef<ProxyIntent | null>(null);
  useEffect(() => {
    heldIntentRef.current = heldIntent;
  }, [heldIntent]);
  // Engine v2 chip removal (YOY-149 AC-15): every chip removed so far in
  // this search chain. A v2 response echoes no intent, so a removal re-asks
  // the same query with this whole list; a search the visitor submits
  // starts a new chain with an empty one.
  const removedChipsRef = useRef<RemovedChip[]>([]);
  // The refinement chain (YOY-150): `carryRef` is the last submitted v2
  // response's `carry`, sent as the next search's `previousQuery`;
  // `chainRef` is the `previousQuery` that produced the response on screen,
  // which a chip removal re-asks with. Memory only (AC-6).
  const carryRef = useRef<string | null>(null);
  const chainRef = useRef<string | null>(null);
  const [carryHeld, setCarryHeld] = useState(false);

  /**
   * Reserve a pending page's label lines and ask once for its labels
   * (YOY-151 AC-8). `fresh` starts a new response's set; a later page
   * adds to the one on screen.
   */
  const awaitLabels = useCallback(
    (page: PlaygroundSearchResponse, fresh: boolean, labelled = true) => {
      const generation = fresh
        ? (labelsGenRef.current += 1)
        : labelsGenRef.current;
      if (fresh) {
        setLateLabels({});
      }
      if (!labelled || page.labelsPending !== true) {
        if (fresh) {
          setLabelsPending(new Set());
        }
        return;
      }
      const ids = page.results.map((card) => card.productId);
      setLabelsPending((held) => new Set([...(fresh ? [] : held), ...ids]));
      fetchPlaygroundLabels({
        searchId: page.searchId,
        page: page.page ?? 1,
        ...(catalog === undefined ? {} : { catalog }),
      }).then(
        (labels) => {
          if (labelsGenRef.current === generation) {
            setLateLabels((held) => ({ ...held, ...labels }));
          }
        },
        () => {
          // The reserved lines stay empty; nothing is said (F-6).
        },
      );
    },
    [catalog],
  );

  const run = useCallback(
    async (
      text: string,
      preview: boolean,
      refinement?: {
        removeChip?: ProxyChip;
        removedChips?: readonly RemovedChip[];
        /** A new submitted search: it sends the held carry (YOY-150 AC-4). */
        submitted?: boolean;
      },
    ) => {
      const trimmed = text.trim();
      if (trimmed === "") {
        return;
      }
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;

      // A preview is classic-only by contract, so it never carries the held
      // intent: refinement is a submitted-search idea (YOY-68, AC-2). An
      // engine v2 removal (YOY-149) carries its removal list and no intent.
      const removedChips = preview ? undefined : refinement?.removedChips;
      const held =
        preview || removedChips !== undefined ? null : heldIntentRef.current;
      // A new submit refines the held chain; a removal re-asks the chain
      // that produced the response on screen (YOY-150 AC-11).
      const previousQuery = preview
        ? null
        : refinement?.submitted === true
          ? carryRef.current
          : chainRef.current;

      pagingRef.current = null;
      setLoadingMore(false);
      setPhase("loading");
      try {
        const next = await searchPlayground({
          query: trimmed,
          preview,
          ...(catalog === undefined ? {} : { catalog }),
          ...(held === null ? {} : { previousIntent: held }),
          ...(refinement?.removeChip === undefined
            ? {}
            : { removeChip: refinement.removeChip }),
          ...(removedChips === undefined ? {} : { removedChips }),
          ...(previousQuery === null ? {} : { previousQuery }),
          // Every submit asks for page 1 (YOY-146 AC-1); a preview is
          // never paged.
          ...(preview ? {} : { paging: { page: 1, pageSize: PAGE_SIZE } }),
          // A preview is classic-only and never names an engine (YOY-165).
          ...(preview || engine === undefined ? {} : { engine }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        setResponse(next);
        setMore([]);
        // A keystroke preview carries no labels (NG-2).
        awaitLabels(next, true, !preview);
        pagingRef.current = preview
          ? null
          : {
              query: trimmed,
              previousIntent: held,
              ...(refinement?.removeChip === undefined
                ? {}
                : { removeChip: refinement.removeChip }),
              ...(removedChips === undefined ? {} : { removedChips }),
              ...(previousQuery === null ? {} : { previousQuery }),
              nextPage: (next.page ?? 1) + 1,
              shown: next.results.length,
              total: next.totalCount ?? next.results.length,
              loading: false,
              stopped: false,
            };
        // The cards on screen are now this response's: attributable only
        // when it was submitted (AC-14).
        setAttributableSearchId(preview ? null : next.searchId);
        // Only a SUBMITTED response replaces the held intent (AC-2). A
        // preview echoes `intent: null` because it is classic-only, so
        // replacing on every response would erase the refinement memory
        // between two keystrokes — a follow-up typed at human speed would
        // then go out with no `previousIntent` at all, and "New search"
        // would blink out mid-typing. The widget keeps its memory across
        // previews for exactly this reason (P-5 parity).
        if (!preview) {
          setHeldIntent(next.intent);
        }
        if (refinement?.submitted === true) {
          // The response's carry is the chain the next submit refines. One
          // with no earlier sentence started a new chain: the old chain's
          // removals end with it, and a removal re-asks it afresh.
          const carry = next.carry ?? null;
          const chained = carry !== null && carry.includes("\n");
          carryRef.current = carry;
          chainRef.current = chained ? previousQuery : null;
          if (!chained) {
            removedChipsRef.current = [];
          }
          setCarryHeld(carry !== null);
        }
        setFailed(false);
        setPhase("settled");
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error as Error).name === "AbortError"
        ) {
          return;
        }
        // The previous results stay exactly where they are; the only change
        // is one quiet line inviting a retry (F-6).
        setFailed(true);
        setPhase("settled");
      }
    },
    [catalog, engine, awaitLabels],
  );

  /**
   * Append the next page below the cards on screen (YOY-146 AC-6 to AC-9):
   * one request per page, the quiet line while it loads, nothing once the
   * shown count reaches `totalCount`, and a failed page leaves every card
   * in place with no error text.
   */
  const loadNextPage = useCallback(async () => {
    const state = pagingRef.current;
    if (
      state === null ||
      state.loading ||
      state.stopped ||
      state.shown >= state.total
    ) {
      return;
    }
    state.loading = true;
    setLoadingMore(true);
    try {
      const next = await searchPlayground({
        query: state.query,
        preview: false,
        ...(catalog === undefined ? {} : { catalog }),
        ...(state.previousIntent === null
          ? {}
          : { previousIntent: state.previousIntent }),
        ...(state.removeChip === undefined
          ? {}
          : { removeChip: state.removeChip }),
        ...(state.removedChips === undefined
          ? {}
          : { removedChips: state.removedChips }),
        ...(state.previousQuery === undefined
          ? {}
          : { previousQuery: state.previousQuery }),
        paging: { page: state.nextPage, pageSize: PAGE_SIZE },
        ...(engine === undefined ? {} : { engine }),
      });
      if (pagingRef.current !== state) {
        return;
      }
      state.nextPage += 1;
      state.shown += next.results.length;
      if (next.results.length === 0) {
        state.stopped = true;
      }
      setMore((shown) => [...shown, ...next.results]);
      awaitLabels(next, false);
    } catch {
      if (pagingRef.current === state) {
        state.stopped = true;
      }
    } finally {
      if (pagingRef.current === state) {
        state.loading = false;
        setLoadingMore(false);
      }
    }
  }, [catalog, engine, awaitLabels]);

  // Stable, so the grid's last-card watch re-arms only when cards change.
  const appendNextPage = useCallback(() => {
    void loadNextPage();
  }, [loadNextPage]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || trimmed === submittedQueryRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      void run(query, true);
    }, PREVIEW_DEBOUNCE_MS);
    debounceRef.current = timer;
    return () => clearTimeout(timer);
  }, [query, run]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
    };
  }, []);

  const submit = useCallback(
    (text?: string) => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      submittedQueryRef.current = (text ?? query).trim();
      // A refinement keeps the chain's removed chips (YOY-150 AC-11); a
      // search with no held chain starts with none.
      if (carryRef.current === null) {
        removedChipsRef.current = [];
      }
      void run(text ?? query, false, {
        submitted: true,
        ...(removedChipsRef.current.length > 0
          ? { removedChips: removedChipsRef.current }
          : {}),
      });
    },
    [query, run],
  );

  /** Forget the refinement chain: the next search starts afresh (YOY-150 AC-5). */
  const dropChain = useCallback(() => {
    carryRef.current = null;
    chainRef.current = null;
    removedChipsRef.current = [];
    setCarryHeld(false);
  }, []);

  const removeChip = useCallback(
    (chip: ProxyChip) => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (heldIntentRef.current !== null) {
        void run(query, false, { removeChip: chip });
        return;
      }
      // Engine v2 (YOY-149 AC-15): no intent to adjust — the same query,
      // page 1, with every chip removed in this chain, the new one included.
      removedChipsRef.current = [
        ...removedChipsRef.current,
        { field: chip.field, value: chip.value },
      ];
      void run(query, false, { removedChips: removedChipsRef.current });
    },
    [query, run],
  );

  /** Drop everything held and go back to the initial state (AC-3). */
  const newSearch = useCallback(() => {
    requestRef.current?.abort();
    pagingRef.current = null;
    setMore([]);
    setLoadingMore(false);
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQuery("");
    submittedQueryRef.current = null;
    dropChain();
    setHeldIntent(null);
    setResponse(null);
    labelsGenRef.current += 1;
    setLabelsPending(new Set());
    setLateLabels({});
    setAttributableSearchId(null);
    setFailed(false);
    setPhase("initial");
    inputRef.current?.focus();
  }, [dropChain]);

  /**
   * A fresh search for `text` with no `previousQuery`: an example query,
   * and the second-reading chip (YOY-150 AC-9) — the reading is a new
   * search, never a re-ordering of these results (NG-3).
   */
  const searchAfresh = useCallback(
    (text: string) => {
      dropChain();
      setQuery(text);
      submit(text);
    },
    [dropChain, submit],
  );

  const openCard = useCallback(
    (card: PlaygroundCard, position: number) => {
      // Preview cards open their link and send nothing: there is no
      // SearchEvent for a click on them to join (AC-14).
      if (attributableSearchId === null) {
        return;
      }
      sendPlaygroundClick({
        searchId: attributableSearchId,
        productId: card.productId,
        position,
        ...(catalog === undefined ? {} : { catalog }),
      });
    },
    [attributableSearchId, catalog],
  );

  // Chips belong to AI-routed responses only: never on a preview, never on
  // classic results, never on a degraded one — a degraded response is
  // classic results wearing the AI route's name (AC-1, AC-4, W-7).
  // An engine v2 response (YOY-149, `intent: null`) carries chips on
  // whichever route its judge took and sends none it did not apply; a
  // preview or a classic v1 response carries none.
  const chips =
    response !== null &&
    !response.degraded &&
    (response.route === "ai" || response.intent === null)
      ? response.chips
      : [];

  // A late label replaces the card's own; card order is the response's,
  // untouched by any label (YOY-151 AC-9). Keystroke-preview cards — the
  // ones no click can be attributed to — carry no label at all (NG-2).
  const previewCards = attributableSearchId === null;
  const cards = useMemo(
    () =>
      [...(response?.results ?? []), ...more].map((card) =>
        previewCards
          ? { ...card, label: null }
          : card.productId in lateLabels
            ? { ...card, label: lateLabels[card.productId] ?? null }
            : card,
      ),
    [response, more, lateLabels, previewCards],
  );
  const closeMatches = response?.closeMatches ?? [];
  const zeroHit =
    response !== null &&
    response.route === "ai" &&
    !response.degraded &&
    response.results.length === 0;

  const status =
    phase === "initial"
      ? strings.initialHint
      : phase === "loading"
        ? strings.loading
        : failed
          ? strings.requestFailed
          : zeroHit
            ? strings.zeroHit
            : response !== null && response.results.length === 0
              ? strings.emptyResults
              : null;

  // The no-JS fallback target, and the URL the toggle writes into history.
  // It carries the query so a real navigation still lands on this search.
  const detailsHref = useMemo(() => {
    const params = new URLSearchParams();
    if (locale === "he") {
      params.set("lang", locale);
    }
    if (query.trim() !== "") {
      params.set("query", query);
    }
    if (!detailsOpen) {
      params.set("details", "1");
    }
    if (engine !== undefined) {
      params.set("engine", engine);
    }
    const search = params.toString();
    return search === "" ? pathname : `${pathname}?${search}`;
  }, [detailsOpen, engine, locale, pathname, query]);

  /**
   * Flip the panel and record it in the URL without navigating, so an
   * opened panel still survives a reload and can be shared, while the
   * answer on screen — and the memory-only held intent — stay put (AC-5).
   */
  const toggleDetails = useCallback(() => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set("details", "1");
    } else {
      url.searchParams.delete("details");
    }
    window.history.replaceState(window.history.state, "", url);
  }, [detailsOpen]);

  const searched = response !== null || phase !== "initial";

  return (
    <div className="playground">
      <header className="header shell">
        <span className="productName">{strings.productName}</span>
        <LanguageToggle
          locale={locale}
          strings={strings}
          pathname={pathname}
          query={query}
          detailsOpen={detailsOpen}
          {...(engine === undefined ? {} : { engine })}
        />
      </header>

      <main className="main shell">
        {store === undefined ? (
          // The demo hero. On a preload page the store's name takes its
          // place and nothing else about the page changes (P-7).
          <section className="hero" data-testid="playground-hero">
            <p className="heroEyebrow">{strings.heroEyebrow}</p>
            <h1 className="heroHeading">{strings.heroHeading}</h1>
            <p className="heroSubcopy">{strings.heroSubcopy}</p>
          </section>
        ) : (
          <StoreLine
            name={store.name}
            productCount={store.productCount}
            strings={strings}
          />
        )}

        {/* The bar, its status line, and the examples are one white card on
            the ivory page: the search is the page's subject, and the card
            is what says so (P-3). */}
        <section className="searchCard" data-testid="playground-search-card">
          {engine === undefined ? null : (
            // Which engine this page view asks for (YOY-165 AC-2): muted
            // text, no colour of its own — a fact for the comparison, not
            // a control.
            <p className="engineBadge" data-testid="playground-engine-badge">
              {strings.engineBadge.replace("{engine}", engine)}
            </p>
          )}
          <SearchBar
            strings={strings}
            value={query}
            onChange={setQuery}
            onSubmit={() => submit()}
            inputRef={inputRef}
          />
          <StatusLine text={status} failed={failed} />

          <ExampleQueries
            locale={locale}
            strings={strings}
            collapsed={searched}
            onPick={searchAfresh}
          />
        </section>

        <div className="applied">
          {chips.length === 0 ? null : (
            <span className="appliedLead" aria-hidden="true">
              {strings.chipsLead}
            </span>
          )}
          <ChipRow
            chips={chips}
            locale={locale}
            strings={strings}
            {...(response?.intent?.currency == null
              ? {}
              : { currency: response.intent.currency })}
            onRemove={removeChip}
            {...(response?.otherReading === undefined
              ? {}
              : { otherReading: response.otherReading, onPickReading: searchAfresh })}
          />
          {heldIntent === null && !carryHeld ? null : (
            <NewSearch strings={strings} onClick={newSearch} />
          )}
        </div>

        {response === null ? null : (
          <EngineDetails
            response={response}
            strings={strings}
            open={detailsOpen}
            toggleHref={detailsHref}
            onToggle={toggleDetails}
          />
        )}

        <ResultsGrid
          cards={cards}
          strings={strings}
          skeleton={phase === "loading" && cards.length === 0}
          labelsPending={labelsPending}
          onOpen={openCard}
          onLastCardVisible={appendNextPage}
        />
        {loadingMore ? (
          // The one quiet line while the next page loads (YOY-146 AC-7):
          // the status line's own ink and size, below the grid — no
          // spinner, no skeleton, no control.
          <p
            className="statusLine"
            role="status"
            data-testid="playground-loading-more"
          >
            {strings.loadingMore}
          </p>
        ) : null}

        {closeMatches.length === 0 ? null : (
          <section className="closeMatches">
            <h2 className="closeMatchesHeading">
              {closeMatchesHeadingText(strings, response?.closeMatchesRelaxed)}
            </h2>
            <ResultsGrid
              cards={closeMatches}
              strings={strings}
              onOpen={openCard}
            />
          </section>
        )}
      </main>

      <footer className="footer shell">{strings.footerNote}</footer>
    </div>
  );
}
