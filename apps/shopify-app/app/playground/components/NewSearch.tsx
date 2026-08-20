import type { PlaygroundStrings } from "../strings";

/**
 * The page's one secondary control (YOY-93 AC-3), shown only once an AI
 * response is held. The magnifier stays the single primary action (P-2), so
 * this is `--surface` on `--border` and never the accent fill.
 */
export function NewSearch({
  strings,
  onClick,
}: {
  strings: PlaygroundStrings;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="newSearch"
      data-testid="playground-new-search"
      onClick={onClick}
    >
      {strings.newSearch}
    </button>
  );
}
