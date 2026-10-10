import { useLayoutEffect, useRef, useState } from "react";

import { formatPrice } from "../../../widget/src/format";
import {
  cardImageFetchPriority,
  cardImageLoading,
  cardImageSources,
} from "../../../widget/src/image-url";
import {
  labelOverflows,
  labelSegments,
  type LabelLike,
  type LabelSegment,
} from "../../../widget/src/labels";
import type { PlaygroundStrings } from "../strings";

/** The card's rendered width (YOY-169): half the viewport on a phone, else ~240 px. */
const CARD_IMAGE_SIZES = "(max-width: 640px) 50vw, 240px";

/**
 * One result card (YOY-92 AC-6), with the widget's card anatomy so what the
 * playground previews is what a store gets (P-5, W-6): square cover image,
 * title, price, the label line (YOY-151), sold-out pill, and nothing else.
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
  /** How it misses a stated wish (YOY-147, YOY-149), or null (YOY-151). */
  label?: LabelLike | null;
}

/**
 * The label line (YOY-151 AC-3, W-11): one line directly under the price,
 * `--text-muted` at `--size-caption`. A label wider than the card is not
 * shown at all — never truncated, never wrapped (AC-6) — and the width is
 * measured before paint, so an overflowing label never flashes. The verdict
 * is held per filled text: a dropped label stays dropped through every
 * later re-render of the page, and only a different text is measured
 * again (a dropped label has no element left to measure). While the
 * page's labels are pending the line is reserved empty (AC-8), at the
 * label's own fixed height, so the label lands without moving the card.
 */
function CardLabel({
  segments,
  reserved,
}: {
  segments: LabelSegment[] | null;
  reserved: boolean;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const text = segments?.map((segment) => segment.text).join("") ?? "";
  const [verdict, setVerdict] = useState<{
    text: string;
    overflows: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (text === "" || verdict?.text === text || ref.current === null) {
      return;
    }
    setVerdict({ text, overflows: labelOverflows(ref.current) });
  }, [text, verdict]);

  const shown =
    segments !== null && !(verdict?.text === text && verdict.overflows);
  if (!shown && !reserved) {
    return null;
  }
  return (
    <span
      ref={ref}
      className="cardLabel"
      data-testid={shown ? "playground-card-label" : undefined}
      data-label-slot={reserved ? "" : undefined}
    >
      {/* A sentence in the chrome's language, so it takes the page's
          direction; each value is isolated, so a Latin amount inside a
          Hebrew sentence keeps its own order (X-7). */}
      {shown
        ? segments.map((segment, index) =>
            segment.value ? (
              <bdi key={index}>{segment.text}</bdi>
            ) : (
              segment.text
            ),
          )
        : null}
    </span>
  );
}

export function Card({
  card,
  position,
  strings,
  labelPending = false,
  onOpen,
}: {
  card: PlaygroundCard;
  position: number;
  strings: PlaygroundStrings;
  /** This card's page is waiting for its late labels (YOY-151 AC-8). */
  labelPending?: boolean;
  onOpen: (card: PlaygroundCard, position: number) => void;
}) {
  const label = labelSegments(strings, card.label);
  const image = card.imageUrl === null ? null : cardImageSources(card.imageUrl);
  const body = (
    <>
      {image === null ? (
        // A neutral block, not a broken image and not an icon: the grid keeps
        // its rhythm and nothing decorative enters the page (X-6).
        <div
          className="cardImagePlaceholder"
          data-testid="playground-card-placeholder"
          aria-hidden="true"
        />
      ) : (
        // Sized by the CDN where it can (YOY-169): 360/540/720 wide for a
        // card that is about 180–240 px, two columns on a phone.
        <img
          className="cardImage"
          // React's spelling, passed explicitly: the helper's DOM-spelled
          // `srcset` key, spread, logs "Invalid DOM property" (YOY-157 AC-25).
          src={image.src}
          srcSet={image.srcset}
          sizes={CARD_IMAGE_SIZES}
          alt=""
          loading={cardImageLoading(position)}
          // The DOM spelling: React 18 does not know `fetchPriority` and
          // would warn (YOY-171 AC-8). Absent past the first row.
          {...(cardImageFetchPriority(position) === undefined
            ? {}
            : { fetchpriority: cardImageFetchPriority(position) })}
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
      <CardLabel segments={label} reserved={labelPending} />
      {card.available ? null : (
        <span className="cardSoldOut" data-testid="playground-card-soldout">
          {strings.soldOut}
        </span>
      )}
    </>
  );

  return (
    <li className="card" data-testid="playground-card">
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
