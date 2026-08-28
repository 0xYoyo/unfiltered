import { Card, type PlaygroundCard } from "./Card";
import type { PlaygroundStrings } from "../strings";

/** Placeholder cards drawn while the first answer is in flight. */
const SKELETON_CARDS = 4;

/**
 * The results grid (YOY-92 AC-6). Results replace, never stack (F-8), and
 * the container keeps a reserved height in CSS so appearing results do not
 * move the search bar.
 *
 * `skeleton` draws sunken card blocks while the FIRST answer is in flight —
 * the shape of the answer, arriving before the answer (DESIGN §2 States).
 * It is off whenever cards are already on screen: a refinement replaces its
 * results in place rather than blanking them, and X-4 keeps the storefront
 * widget's overlay free of any such placeholder. It carries no animation,
 * so `prefers-reduced-motion` has nothing to switch off (F-2).
 */
export function ResultsGrid({
  cards,
  strings,
  skeleton = false,
  onOpen,
}: {
  cards: PlaygroundCard[];
  strings: PlaygroundStrings;
  skeleton?: boolean;
  onOpen: (card: PlaygroundCard, position: number) => void;
}) {
  if (cards.length === 0 && skeleton) {
    return (
      <div className="results">
        <div
          className="grid skeletonGrid"
          aria-hidden="true"
          data-testid="playground-skeleton"
        >
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <div className="skeletonCard" key={index} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="results">
      {cards.length === 0 ? null : (
        <ul
          className="grid"
          aria-label={strings.resultsLabel}
          data-testid="playground-grid"
        >
          {cards.map((card, index) => (
            <Card
              key={card.productId}
              card={card}
              position={index}
              strings={strings}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
