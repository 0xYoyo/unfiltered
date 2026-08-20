import { formatPrice } from "../../../widget/src/format";
import type { PlaygroundStrings } from "../strings";

/**
 * One result card (YOY-92 AC-6), with the widget's card anatomy so what the
 * playground previews is what a store gets (P-5, W-6): square cover image,
 * title, price, sold-out pill, and nothing else.
 *
 * `formatPrice` is imported from the widget rather than reimplemented — the
 * one import NG-3 allows — so a price never reads differently on the two
 * surfaces.
 */

export interface PlaygroundCard {
  productId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  priceMin: number;
  priceMax: number;
  currencyCode: string;
  available: boolean;
  /** Passed a colour filter without colour evidence (YOY-93 AC-4). */
  colorUnknown?: boolean;
}

export function Card({
  card,
  position,
  strings,
  onOpen,
}: {
  card: PlaygroundCard;
  position: number;
  strings: PlaygroundStrings;
  onOpen: (card: PlaygroundCard, position: number) => void;
}) {
  const body = (
    <>
      {card.imageUrl === null ? (
        // A neutral block, not a broken image and not an icon: the grid keeps
        // its rhythm and nothing decorative enters the page (X-6).
        <div
          className="cardImagePlaceholder"
          data-testid="playground-card-placeholder"
          aria-hidden="true"
        />
      ) : (
        <img
          className="cardImage"
          src={card.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
        />
      )}
      <span className="cardTitle">{card.title}</span>
      <span className="cardPrice">
        {/* Isolated and forced LTR: a price is a Latin number plus a
            currency code, and inside Hebrew chrome the bidi algorithm
            otherwise reorders a range into "320–280" (X-7). */}
        <bdi dir="ltr">
          {formatPrice(card.priceMin, card.priceMax, card.currencyCode)}
        </bdi>
      </span>
      {card.available ? null : (
        <span className="cardSoldOut" data-testid="playground-card-soldout">
          {strings.soldOut}
        </span>
      )}
      {card.colorUnknown !== true ? null : (
        // Widget parity (W-8, P-5): a product that satisfied a colour filter
        // without colour evidence is shown, but says so and is de-emphasised
        // rather than presented with the same confidence as a real match.
        <span
          className="cardColorUnknown"
          data-testid="playground-card-color-unknown"
        >
          {strings.colorNotConfirmed}
        </span>
      )}
    </>
  );

  return (
    <li
      className={card.colorUnknown === true ? "card cardDimmed" : "card"}
      data-testid="playground-card"
      data-color-unknown={card.colorUnknown === true ? "true" : undefined}
    >
      {card.url === null ? (
        // No anchor at all rather than a dead one: a link that goes nowhere
        // is a worse answer than plain text (AC-6).
        <div className="cardLink">{body}</div>
      ) : (
        <a
          className="cardLink"
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onOpen(card, position)}
        >
          {body}
        </a>
      )}
    </li>
  );
}
