import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { getPlaygroundStrings } from "../strings";
import { Card, type PlaygroundCard } from "./Card";

/**
 * The card passes `srcSet` the React way (YOY-157 AC-25). React warns about a
 * DOM-spelled `srcset` prop only in its development build, and the UI lane
 * serves the production build, so this renders the card in development mode
 * (the test environment) and watches for the warning.
 */

const card: PlaygroundCard = {
  productId: "p1",
  title: "Linen shirt",
  url: null,
  imageUrl: "https://cdn.shopify.com/s/files/1/0001/products/shirt.jpg?v=1712345678",
  priceMin: 40,
  priceMax: 40,
  currencyCode: "USD",
  available: true,
};

describe("playground card image (YOY-157 AC-25)", () => {
  it("renders the 360/540/720 srcset with no Invalid DOM property warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(
      <Card card={card} position={0} strings={getPlaygroundStrings("en")} onOpen={() => undefined} />,
    );
    const warnings = errors.mock.calls.map((call) => call.map(String).join(" "));
    errors.mockRestore();

    expect(warnings.filter((text) => text.includes("Invalid DOM property"))).toEqual([]);
    const srcset = /srcSet="([^"]*)"/i.exec(html)?.[1] ?? "";
    expect(srcset.split(", ").map((entry) => entry.split(" ")[1])).toEqual(["360w", "540w", "720w"]);
    expect(html).toMatch(/src="[^"]*width=360/);
  });
});
