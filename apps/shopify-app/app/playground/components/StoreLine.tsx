import type { PlaygroundStrings } from "../strings";

/**
 * The store's name on a preload page (YOY-94 AC-2, P-7).
 *
 * This is the ONLY thing that changes when the playground is pointed at a
 * particular store's catalog: one line of body type above the bar, with the
 * product count muted beside it. No logo, no colour, no per-store copy —
 * P-7 makes the page visibly the store's by naming it, not by dressing up
 * as it, and the rest of the chrome stays identical to `/`.
 */
export function StoreLine({
  name,
  productCount,
  strings,
}: {
  name: string;
  productCount: number;
  strings: PlaygroundStrings;
}) {
  return (
    <p className="storeLine" data-store-line data-testid="playground-store-line">
      <span className="storeName">{name}</span>
      <span className="storeCount">
        {strings.storeProducts.replace("{count}", String(productCount))}
      </span>
    </p>
  );
}
