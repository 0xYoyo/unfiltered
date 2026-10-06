import { Fragment, useEffect, useRef } from "react";

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
  labelsPending,
  closeStarts,
  closeHeading,
  onOpen,
  onLastCardVisible,
}: {
  cards: PlaygroundCard[];
  strings: PlaygroundStrings;
  skeleton?: boolean;
  /**
   * The cards whose page waits on late labels (YOY-151 AC-8): each
   * reserves its label line so the labels land without moving anything.
   */
  labelsPending?: ReadonlySet<string>;
  /**
   * The cards each page's close products start at (YOY-166 AC-2, AC-3): a
   * full-row "Close matches" divider goes before each, so every appended
   * page repeats it under its own results.
   */
  closeStarts?: ReadonlySet<string>;
  /** The divider's heading text; required with `closeStarts`. */
  closeHeading?: string;
  onOpen: (card: PlaygroundCard, position: number) => void;
  /**
   * Called when the last card enters the viewport (YOY-146 AC-6): the page
   * appends the next page below. Re-armed whenever the card count changes.
   */
  onLastCardVisible?: () => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const last = listRef.current?.lastElementChild;
    if (
      onLastCardVisible === undefined ||
      last === null ||
      last === undefined ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        onLastCardVisible();
      }
    });
    observer.observe(last);
    return () => observer.disconnect();
  }, [cards.length, onLastCardVisible]);

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
          ref={listRef}
          className="grid"
          aria-label={strings.resultsLabel}
          data-testid="playground-grid"
        >
          {cards.map((card, index) => (
            <Fragment key={card.productId}>
              {closeStarts?.has(card.productId) === true ? (
                <li
                  className="closeMatchesDivider"
                  data-testid="playground-close-matches-divider"
                >
                  <h2 className="closeMatchesHeading">{closeHeading}</h2>
                </li>
              ) : null}
              <Card
                card={card}
                position={index}
                strings={strings}
                labelPending={labelsPending?.has(card.productId) ?? false}
                onOpen={onOpen}
              />
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
