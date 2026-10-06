import { describe, expect, it } from "vitest";

import type { ProxyIntent } from "../search/proxy.server";
import { playgroundEngineParam, playgroundSearchUrl } from "./search-client";

/**
 * The engine a `/try?engine=` page view asks for (YOY-165 AC-1, AC-4): read
 * from the page URL, sent on every submitted request, never on a preview.
 * The rendered badge and the requests the page sends are proven in the
 * Playwright lane (test-ui/engine.spec.ts).
 */

const params = (url: string) => new URL(url, "http://localhost").searchParams;

const RED_DRESS: ProxyIntent = {
  category: "dress",
  priceMin: null,
  priceMax: null,
  currency: null,
  colorsInclude: ["red"],
  colorsExclude: [],
  attributesExclude: [],
  attributesInclude: [],
  occasion: null,
  size: null,
  availabilityRequired: false,
  softAttributes: [],
};

describe("the playground's engine parameter (YOY-165)", () => {
  it("reads v1 or v2 from the page URL and ignores anything else", () => {
    expect(playgroundEngineParam("v1")).toBe("v1");
    expect(playgroundEngineParam("v2")).toBe("v2");
    expect(playgroundEngineParam("V1")).toBeUndefined();
    expect(playgroundEngineParam("v3")).toBeUndefined();
    expect(playgroundEngineParam("")).toBeUndefined();
    expect(playgroundEngineParam(null)).toBeUndefined();
  });

  it("emits engine=v1 on a submitted search and on a page request", () => {
    expect(
      params(
        playgroundSearchUrl({
          query: "red dress",
          preview: false,
          sessionId: "s-1",
          engine: "v1",
          paging: { page: 1, pageSize: 24 },
        }),
      ).get("engine"),
    ).toBe("v1");
    expect(
      params(
        playgroundSearchUrl({
          query: "red dress",
          preview: false,
          sessionId: "s-1",
          engine: "v2",
          paging: { page: 2, pageSize: 24 },
        }),
      ).get("engine"),
    ).toBe("v2");
  });

  it("keeps the engine on a follow-up: a v1 refinement and a v2 chip removal", () => {
    const v1 = params(
      playgroundSearchUrl({
        query: "in blue",
        preview: false,
        sessionId: "s-1",
        engine: "v1",
        previousIntent: RED_DRESS,
      }),
    );
    expect(v1.get("engine")).toBe("v1");
    expect(v1.has("previousIntent")).toBe(true);

    const v2 = params(
      playgroundSearchUrl({
        query: "budget dress",
        preview: false,
        sessionId: "s-1",
        engine: "v2",
        previousQuery: "budget dress",
        removedChips: [{ field: "priceMax", value: "400" }],
      }),
    );
    expect(v2.get("engine")).toBe("v2");
    expect(v2.has("removedChips")).toBe(true);
    expect(v2.get("previousQuery")).toBe("budget dress");
  });

  it("omits the engine on a keystroke preview, and when none is asked for", () => {
    const preview = params(
      playgroundSearchUrl({ query: "red", preview: true, sessionId: "s-1", engine: "v1" }),
    );
    expect(preview.get("mode")).toBe("preview");
    expect(preview.has("engine")).toBe(false);
    expect(
      params(playgroundSearchUrl({ query: "red dress", preview: false, sessionId: "s-1" })).has(
        "engine",
      ),
    ).toBe(false);
  });
});
