import { describe, expect, it } from "vitest";

import {
  CARD_IMAGE_WIDTHS,
  cardImageLoading,
  cardImageSources,
  FIRST_ROW_CARDS,
  sizedImageUrl,
} from "../../widget/src/image-url";

/**
 * Sized card images (YOY-169 AC-1, AC-3): the one helper both the
 * playground card and the widget overlay card read their image attributes
 * from. The UI lanes prove the attributes land on the rendered `<img>`.
 */

const SHOPIFY = "https://cdn.shopify.com/s/files/1/0001/files/dress.jpg?v=1712345678";

describe("sizedImageUrl (AC-1)", () => {
  it("adds `width` to a cdn.shopify.com URL and keeps `v=`", () => {
    const sized = new URL(sizedImageUrl(SHOPIFY, 360));
    expect(sized.hostname).toBe("cdn.shopify.com");
    expect(sized.pathname).toBe("/s/files/1/0001/files/dress.jpg");
    expect(sized.searchParams.get("v")).toBe("1712345678");
    expect(sized.searchParams.get("width")).toBe("360");
  });

  it("replaces an existing `width` rather than adding a second", () => {
    const sized = new URL(sizedImageUrl(`${SHOPIFY}&width=1400&crop=center`, 540));
    expect(sized.searchParams.getAll("width")).toEqual(["540"]);
    expect(sized.searchParams.get("crop")).toBe("center");
    expect(sized.searchParams.get("v")).toBe("1712345678");
  });

  it("tolerates a URL with no query", () => {
    expect(sizedImageUrl("https://cdn.shopify.com/s/files/x.jpg", 720)).toBe(
      "https://cdn.shopify.com/s/files/x.jpg?width=720",
    );
  });

  it("leaves any other host, a data URI and a malformed URL unchanged", () => {
    for (const url of [
      "https://images.example.com/products/dress.jpg?v=3",
      "https://cdn.shopify.com.evil.example/x.jpg",
      "data:image/svg+xml;utf8,<svg/>",
      "not a url",
    ]) {
      expect(sizedImageUrl(url, 360)).toBe(url);
    }
  });
});

describe("cardImageSources and loading (AC-2)", () => {
  it("gives a Shopify-hosted image a 360 src and a 360/540/720 srcset", () => {
    const sources = cardImageSources(SHOPIFY);
    expect(new URL(sources.src).searchParams.get("width")).toBe("360");
    expect(
      sources.srcset!.split(", ").map((entry) => {
        const [url, descriptor] = entry.split(" ");
        return [new URL(url!).searchParams.get("width"), descriptor];
      }),
    ).toEqual(CARD_IMAGE_WIDTHS.map((width) => [String(width), `${width}w`]));
  });

  it("keeps a crawl-sourced image's plain src, with no srcset", () => {
    const url = "https://shop.example.com/cdn/dress.jpg";
    expect(cardImageSources(url)).toEqual({ src: url });
  });

  it("loads the first row eagerly and every later card lazily", () => {
    expect(cardImageLoading(0)).toBe("eager");
    expect(cardImageLoading(FIRST_ROW_CARDS - 1)).toBe("eager");
    expect(cardImageLoading(FIRST_ROW_CARDS)).toBe("lazy");
    expect(cardImageLoading(30)).toBe("lazy");
  });
});
