import { Card, type PlaygroundCard } from "./Card";
import type { PlaygroundStrings } from "../strings";

/**
 * The results grid (YOY-92 AC-6). Results replace, never stack (F-8), and
 * the container keeps a reserved height in CSS so appearing results do not
 * move the search bar.
 */
export function ResultsGrid({
  cards,
  strings,
  onOpen,
}: {
  cards: PlaygroundCard[];
  strings: PlaygroundStrings;
  onOpen: (card: PlaygroundCard, position: number) => void;
}) {
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
