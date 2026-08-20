import { exampleQueriesFor } from "../strings";
import type { PlaygroundLocale, PlaygroundStrings } from "../strings";

/**
 * Example queries (YOY-93 AC-6, P-6). Six of them: four in the chrome
 * language and two in the other, because the claim being demonstrated is
 * that either language works, and showing only the reader's own proves half
 * of it. Each link carries its own `lang`/`dir` so a Hebrew example inside
 * English chrome renders right (X-7).
 *
 * They are text links, never pills: a pill here would read as an applied
 * filter and collide with the chip row's meaning (P-2, W-7).
 *
 * Under the initial state they sit under the bar as a list; once a search
 * has run they collapse to a single "Try:" row, so they never compete with
 * the results.
 */
export function ExampleQueries({
  locale,
  strings,
  collapsed,
  onPick,
}: {
  locale: PlaygroundLocale;
  strings: PlaygroundStrings;
  collapsed: boolean;
  onPick: (query: string) => void;
}) {
  const examples = exampleQueriesFor(locale);

  return (
    <div
      className={collapsed ? "examples examplesCollapsed" : "examples"}
      aria-label={strings.examplesLabel}
      data-testid="playground-examples"
      data-collapsed={collapsed ? "true" : "false"}
    >
      {collapsed ? (
        <span className="examplesLead">{strings.examplesLead}</span>
      ) : null}
      {examples.map(({ locale: exampleLocale, query }) => (
        <button
          key={`${exampleLocale}:${query.kind}`}
          type="button"
          className="exampleQuery"
          lang={exampleLocale}
          dir={exampleLocale === "he" ? "rtl" : "ltr"}
          data-testid="playground-example"
          data-example-locale={exampleLocale}
          onClick={() => onPick(query.text)}
        >
          {query.text}
        </button>
      ))}
    </div>
  );
}
