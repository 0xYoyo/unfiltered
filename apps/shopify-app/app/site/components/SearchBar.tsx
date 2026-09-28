/**
 * The design export's SearchBar, as the marketing pages show it: a pill with
 * a 1px ink border, the × mark, a serif input and the one red submit
 * control. On the site it only illustrates — the working search is /try —
 * so its value is driven by the page and submitting does nothing.
 */
export function SearchBar({
  value,
  size = "hero",
  placeholder = "Describe what you're looking for…",
  submitLabel = "Search",
}: {
  value: string;
  size?: "hero" | "compact";
  placeholder?: string;
  submitLabel?: string;
}) {
  const markSize = size === "hero" ? 26 : 20;
  return (
    <form
      className={`unf-search unf-search--${size}`}
      onSubmit={(event) => event.preventDefault()}
    >
      <span className="unf-search__mark">
        <svg
          width={markSize}
          height={markSize}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="10.5"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8 8 L16 16 M16 8 L8 16"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input
        className="unf-search__input"
        aria-label={submitLabel}
        value={value}
        placeholder={placeholder}
        readOnly
      />
      <button type="submit" className="unf-search__go">
        {submitLabel}
      </button>
    </form>
  );
}
