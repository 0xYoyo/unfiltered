import type { ProxyChip } from "../../search/proxy.server";
import { chipLabel } from "../../../widget/src/format";
import type { PlaygroundLocale, PlaygroundStrings } from "../strings";

/**
 * Applied constraints as removable chips (YOY-93 AC-1) — filters as OUTPUT,
 * which is the difference the playground exists to show.
 *
 * Same anatomy and same rules as the widget's chip row (P-5, W-7): label
 * plus remove glyph, `--surface` on `--border`, hover darkens the border
 * only, and the whole chip is the remove control so the affordance clears
 * the hit-target floor (F-3). Labels come from the widget's own `chipLabel`
 * so Hebrew display cannot drift between the two surfaces.
 *
 * Never rendered for a preview or a classic-routed response — the caller
 * enforces that, because a chip on classic results would claim an
 * understanding the engine did not have.
 */
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
        return (
          <li key={`${chip.field}:${chip.value}`}>
            <button
              type="button"
              className="chip"
              data-testid="playground-chip"
              data-chip-field={chip.field}
              data-chip-value={chip.value}
              aria-label={strings.removeFilter.replace("{label}", label)}
              onClick={() => onRemove(chip)}
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
