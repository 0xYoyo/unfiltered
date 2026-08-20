import type { PlaygroundStrings } from "../strings";

/**
 * The unknown-slug page (YOY-94 AC-1). A shared link outlives the catalog it
 * pointed at, so this is a designed page in the playground's own shell —
 * one quiet sentence and a way onward — never a framework error screen and
 * never error language (F-6).
 */
export function CatalogNotFound({ strings }: { strings: PlaygroundStrings }) {
  return (
    <div className="catalogNotFound">
      <p className="catalogNotFoundText">{strings.catalogNotFound}</p>
      <a className="catalogNotFoundLink" href="/">
        {strings.backToPlayground}
      </a>
    </div>
  );
}
