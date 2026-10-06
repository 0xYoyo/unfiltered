import type { PlaygroundEngine } from "../search-client";
import type { PlaygroundLocale, PlaygroundStrings } from "../strings";

/**
 * Chrome language switch (YOY-92 AC-3): a link that rewrites `?lang=` on the
 * current path, so the server resolves the language and `<html lang dir>` is
 * right in the first byte.
 *
 * It is a link rather than a button because the language is part of the
 * URL — shareable, back-navigable, and correct without JavaScript. The typed
 * query is carried across in `?query=` so the input is not cleared by the
 * switch (AC-3).
 */
export function LanguageToggle({
  locale,
  strings,
  pathname,
  query,
  detailsOpen,
  engine,
}: {
  locale: PlaygroundLocale;
  strings: PlaygroundStrings;
  pathname: string;
  query: string;
  detailsOpen: boolean;
  /** The engine the page view asks for (YOY-165); kept across the switch. */
  engine?: PlaygroundEngine;
}) {
  const target: PlaygroundLocale = locale === "he" ? "en" : "he";
  const params = new URLSearchParams({ lang: target });
  if (query !== "") {
    params.set("query", query);
  }
  // Switching language must not close an opened details panel (AC-5).
  if (detailsOpen) {
    params.set("details", "1");
  }
  if (engine !== undefined) {
    params.set("engine", engine);
  }

  return (
    <a
      className="languageToggle"
      href={`${pathname}?${params.toString()}`}
      lang={target}
      aria-label={strings.languageToggle}
      data-testid="playground-language-toggle"
    >
      {strings.languageToggleTarget}
    </a>
  );
}
