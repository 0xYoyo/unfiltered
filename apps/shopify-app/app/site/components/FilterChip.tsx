/**
 * The design export's FilterChip: solid for what the shopper said, a
 * strike-through for a negation, dashed for what was inferred (readme
 * "Brand glyphs"). The × is optional; without it the chip is static.
 */
export type ChipVariant = "include" | "exclude" | "derived";

export interface Chip {
  label: string;
  variant?: ChipVariant;
}

export function FilterChip({
  label,
  variant = "include",
  onRemove,
}: {
  label: string;
  variant?: ChipVariant;
  onRemove?: () => void;
}) {
  const className = [
    "unf-chip",
    `unf-chip--${variant}`,
    onRemove ? "" : "unf-chip--static",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className}>
      <span className="unf-chip__label">{label}</span>
      {onRemove ? (
        <button
          type="button"
          className="unf-chip__x"
          aria-label={`Remove filter ${label}`}
          onClick={onRemove}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </span>
  );
}
