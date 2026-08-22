import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProxyChip, ProxyIntent } from "../search/proxy.server";
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
  searchPlayground,
  sendPlaygroundClick,
} from "./search-client";
import { getPlaygroundStrings, type PlaygroundLocale } from "./strings";

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
 */

type Phase = "initial" | "loading" | "settled";

export function PlaygroundPage({
  locale,
  pathname,
  initialQuery,
  detailsOpen: initialDetailsOpen,
  catalog,
  store,
}: {
  locale: PlaygroundLocale;
  pathname: string;
  initialQuery: string;
  detailsOpen: boolean;
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

  const run = useCallback(
    async (
      text: string,
      preview: boolean,
      refinement?: { removeChip?: ProxyChip },
    ) => {
      const trimmed = text.trim();
      if (trimmed === "") {
        return;
      }
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;

      // A preview is classic-only by contract, so it never carries the held
      // intent: refinement is a submitted-search idea (YOY-68, AC-2).
      const held = preview ? null : heldIntentRef.current;

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
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        setResponse(next);
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
    [catalog],
  );

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
      void run(text ?? query, false);
    },
    [query, run],
  );

  const removeChip = useCallback(
    (chip: ProxyChip) => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void run(query, false, { removeChip: chip });
    },
    [query, run],
  );

  /** Drop everything held and go back to the initial state (AC-3). */
  const newSearch = useCallback(() => {
    requestRef.current?.abort();
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQuery("");
    submittedQueryRef.current = null;
    setHeldIntent(null);
    setResponse(null);
    setAttributableSearchId(null);
    setFailed(false);
    setPhase("initial");
    inputRef.current?.focus();
  }, []);

  const pickExample = useCallback(
    (text: string) => {
      setQuery(text);
      submit(text);
    },
    [submit],
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
  const chips =
    response !== null && response.route === "ai" && !response.degraded
      ? response.chips
      : [];

  const cards = response?.results ?? [];
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
    const search = params.toString();
    return search === "" ? pathname : `${pathname}?${search}`;
  }, [detailsOpen, locale, pathname, query]);

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
        />
      </header>

      <main className="main shell">
        {store === undefined ? null : (
          <StoreLine
            name={store.name}
            productCount={store.productCount}
            strings={strings}
          />
        )}
        <SearchBar
          strings={strings}
          value={query}
          onChange={setQuery}
          onSubmit={() => submit()}
          inputRef={inputRef}
        />
        <StatusLine text={status} />

        <ExampleQueries
          locale={locale}
          strings={strings}
          collapsed={searched}
          onPick={pickExample}
        />

        <div className="applied">
          <ChipRow
            chips={chips}
            locale={locale}
            strings={strings}
            {...(response?.intent?.currency == null
              ? {}
              : { currency: response.intent.currency })}
            onRemove={removeChip}
          />
          {heldIntent === null ? null : (
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

        <ResultsGrid cards={cards} strings={strings} onOpen={openCard} />

        {closeMatches.length === 0 ? null : (
          <section className="closeMatches">
            <h2 className="closeMatchesHeading">
              {strings.closeMatchesHeading}
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
