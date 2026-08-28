import { useCallback, useRef, useState } from "react";

import type { ProxyChip } from "../../search/proxy.server";
import { chipLabel, isNegationChip } from "../../../widget/src/format";
import type { PlaygroundLocale, PlaygroundStrings } from "../strings";

/**
 * Applied constraints as removable chips (YOY-93 AC-1) — filters as OUTPUT,
 * which is the difference the playground exists to show.
 *
 * Same anatomy as the widget's chip row (P-5, W-7): label plus remove
 * glyph, and the whole chip is the remove control so the affordance clears
 * the hit-target floor (F-3). Labels come from the widget's own `chipLabel`
 * so Hebrew display cannot drift between the two surfaces. The playground's
 * chips carry the playground's own skin — the widget's stay inherit-first
 * inside a merchant theme (W-3, W-4), which is why only the anatomy is
 * shared.
 *
 * A NEGATED constraint (`isNegationChip`, shared with the widget so the two
 * surfaces cannot disagree about what an exclusion is) is tinted:
 * `--surface-accent-soft` behind `--border-accent`, the one place the
 * accent touches a chip (P-2). "Not black" and "black" are opposite
 * instructions and read as the same chip otherwise.
 *
 * Removal animates the chip out over `--dur-chip-out` before the search
 * re-runs, so the row visibly loses the constraint the click removed
 * (DESIGN §2 Motion). Under `prefers-reduced-motion` the removal fires at
 * once (F-2).
 *
 * Never rendered for a preview or a classic-routed response — the caller
 * enforces that, because a chip on classic results would claim an
 * understanding the engine did not have.
 */

/** Kept in step with `--dur-chip-out` in tokens.css. */
const CHIP_OUT_MS = 200;

function chipKey(chip: ProxyChip): string {
  return `${chip.field}:${chip.value}`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function ChipRow({
  chips,
  locale,
  strings,
  currency,
  onRemove,
}: {
  chips: ProxyChip[];
  locale: PlaygroundLocale;
  strings: PlaygroundStrings;
  currency?: string;
  onRemove: (chip: ProxyChip) => void;
}) {
  const [leaving, setLeaving] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remove = useCallback(
    (chip: ProxyChip) => {
      // A second click while one chip is already leaving would race two
      // searches; the first removal is the one that counts.
      if (timerRef.current !== null) {
        return;
      }
      if (prefersReducedMotion()) {
        onRemove(chip);
        return;
      }
      setLeaving(chipKey(chip));
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setLeaving(null);
        onRemove(chip);
      }, CHIP_OUT_MS);
    },
    [onRemove],
  );

  if (chips.length === 0) {
    return null;
  }

  return (
    <ul
      className="chips"
      aria-label={strings.appliedFilters}
      data-testid="playground-chips"
    >
      {chips.map((chip) => {
        const label = chipLabel(chip, {
          locale,
          ...(currency === undefined ? {} : { currency }),
        });
        const key = chipKey(chip);
        const negated = isNegationChip(chip);
        const className = [
          "chip",
          negated ? "chipNegated" : null,
          leaving === key ? "chipLeaving" : null,
        ]
          .filter((name) => name !== null)
          .join(" ");
        return (
          <li key={key}>
            <button
              type="button"
              className={className}
              data-testid="playground-chip"
              data-chip-field={chip.field}
              data-chip-value={chip.value}
              data-chip-negated={negated ? "true" : undefined}
              aria-label={strings.removeFilter.replace("{label}", label)}
              onClick={() => remove(chip)}
            >
              <span>{label}</span>
              <span className="chipRemove" aria-hidden="true">
                ×
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
