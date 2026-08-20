import { useCallback, useEffect, useRef, useState } from "react";

import type { PlaygroundCard } from "./components/Card";
import { LanguageToggle } from "./components/LanguageToggle";
import { ResultsGrid } from "./components/ResultsGrid";
import { SearchBar } from "./components/SearchBar";
import { StatusLine } from "./components/StatusLine";
import {
  PREVIEW_DEBOUNCE_MS,
  searchPlayground,
  sendPlaygroundClick,
} from "./search-client";
import {
  getPlaygroundStrings,
  type PlaygroundLocale,
} from "./strings";

/**
 * The playground page (YOY-92): header, hero search bar, status line, and
 * results grid — and deliberately nothing else. It is Unfiltered's only
 * owned page, so every element on it is one the design invariants name
 * (P-1, P-3, X-1, X-3, X-6).
 *
 * The interaction model is the widget's (YOY-68, AC-5): typing issues
 * debounced classic-only previews that spend no AI budget and write no
 * SearchEvent, and Enter or the magnifier submits the full pipeline. Results
 * replace rather than stack, and every state renders in the same boxes so
 * the search bar never moves (F-8).
 */

/** What the page is currently showing. */
type Phase = "initial" | "loading" | "settled";

export function PlaygroundPage({
  locale,
  pathname,
  initialQuery,
  catalog,
}: {
  locale: PlaygroundLocale;
  pathname: string;
  initialQuery: string;
  catalog?: string;
}) {
  const strings = getPlaygroundStrings(locale);

  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>("initial");
  const [cards, setCards] = useState<PlaygroundCard[]>([]);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [emptied, setEmptied] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // One in-flight request at a time: a slower earlier response must never
  // overwrite a newer one (results replace, and only the newest wins).
  const requestRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (text: string, preview: boolean) => {
      const trimmed = text.trim();
      if (trimmed === "") {
        return;
      }
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;

      setPhase("loading");
      try {
        const response = await searchPlayground({
          query: trimmed,
          preview,
          ...(catalog === undefined ? {} : { catalog }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        setCards(response.results);
        setSearchId(response.searchId);
        setEmptied(response.results.length === 0);
        setFailed(false);
        setPhase("settled");
      } catch (error) {
        if (controller.signal.aborted || (error as Error).name === "AbortError") {
          return;
        }
        // The previous results stay exactly where they are; the only change
        // is one quiet line inviting a retry (AC-7, F-6).
        setFailed(true);
        setEmptied(false);
        setPhase("settled");
      }
    },
    [catalog],
  );

  // Keystrokes: debounced previews. The submitted path never waits on this
  // timer — it clears it, so Enter is immediate.
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

  const submit = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void run(query, false);
  }, [query, run]);

  const openCard = useCallback(
    (card: PlaygroundCard, position: number) => {
      if (searchId === null) {
        return;
      }
      sendPlaygroundClick({
        searchId,
        productId: card.productId,
        position,
        ...(catalog === undefined ? {} : { catalog }),
      });
    },
    [catalog, searchId],
  );

  const status =
    phase === "initial"
      ? strings.initialHint
      : phase === "loading"
        ? strings.loading
        : failed
          ? strings.requestFailed
          : emptied
            ? strings.emptyResults
            : null;

  return (
    <div className="playground">
      <header className="header shell">
        <span className="productName">{strings.productName}</span>
        <LanguageToggle
          locale={locale}
          strings={strings}
          pathname={pathname}
          query={query}
        />
      </header>

      <main className="main shell">
        <SearchBar
          strings={strings}
          value={query}
          onChange={setQuery}
          onSubmit={submit}
          inputRef={inputRef}
        />
        <StatusLine text={status} />
        <ResultsGrid cards={cards} strings={strings} onOpen={openCard} />
      </main>

      <footer className="footer shell">{strings.footerNote}</footer>
    </div>
  );
}
