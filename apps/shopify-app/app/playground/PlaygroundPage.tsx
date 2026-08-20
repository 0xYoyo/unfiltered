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
  detailsOpen,
  catalog,
}: {
  locale: PlaygroundLocale;
  pathname: string;
  initialQuery: string;
  detailsOpen: boolean;
  catalog?: string;
}) {
  const strings = getPlaygroundStrings(locale);

  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>("initial");
  const [response, setResponse] = useState<PlaygroundSearchResponse | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  // The held intent: the last AI response's echoed intent, in memory only.
  const [heldIntent, setHeldIntent] = useState<ProxyIntent | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // One in-flight request at a time: a slower earlier response must never
  // overwrite a newer one (results replace, and only the newest wins).
  const requestRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        // Each response's echoed intent replaces the held one (AC-2). A
        // classic or preview response echoes null, which correctly drops it:
        // there is no understanding to refine.
        setHeldIntent(next.intent);
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
    if (query.trim() === "") {
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
    setHeldIntent(null);
    setResponse(null);
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
      if (response === null) {
        return;
      }
      sendPlaygroundClick({
        searchId: response.searchId,
        productId: card.productId,
        position,
        ...(catalog === undefined ? {} : { catalog }),
      });
    },
    [catalog, response],
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

  const detailsHref = useMemo(() => {
    const params = new URLSearchParams();
    if (locale === "he") {
      params.set("lang", locale);
    }
    if (!detailsOpen) {
      params.set("details", "1");
    }
    const search = params.toString();
    return search === "" ? pathname : `${pathname}?${search}`;
  }, [detailsOpen, locale, pathname]);

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
