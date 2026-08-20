import type { Ref } from "react";

import type { PlaygroundStrings } from "../strings";

/**
 * The hero search bar (YOY-92 AC-4): full content width, the only
 * display-size type on the page, with the submit magnifier inside the field
 * at the inline-end so it mirrors under RTL without a second rule (P-3, F-5).
 */
export function SearchBar({
  strings,
  value,
  onChange,
  onSubmit,
  inputRef,
}: {
  strings: PlaygroundStrings;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <form
      className="searchForm"
      role="search"
      aria-label={strings.searchLabel}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="searchField">
        <input
          ref={inputRef}
          className="searchInput"
          type="search"
          name="query"
          autoComplete="off"
          // The browser's own clear/decoration widgets would sit where the
          // magnifier does and fight the mirrored layout.
          data-testid="playground-input"
          placeholder={strings.searchPlaceholder}
          aria-label={strings.searchLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="searchSubmit"
          type="submit"
          aria-label={strings.searchSubmit}
          data-testid="playground-submit"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <circle
              cx="11"
              cy="11"
              r="6.25"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="m15.5 15.5 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}
