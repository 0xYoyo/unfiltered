import { describe, expect, it } from "vitest";

import { ownedPageKind } from "./strings";

/**
 * `ownedPageKind` decides, server-side, which pages self-host their fonts
 * and which resolve a chrome language (root.tsx). The router serves a path
 * with a trailing slash as the same page, so the answer must not change
 * with it — otherwise `/pricing/` would load the admin's Shopify-CDN
 * stylesheet and `/try/?lang=he` would render left-to-right.
 */
describe("ownedPageKind", () => {
  it("answers the same with or without a trailing slash", () => {
    for (const [path, kind] of [
      ["/", "site"],
      ["/pricing", "site"],
      ["/pricing/", "site"],
      ["/how-it-works//", "site"],
      ["/try", "playground"],
      ["/try/", "playground"],
      ["/s/demo-store", "playground"],
      ["/s/demo-store/", "playground"],
      ["/app", null],
      ["/app/", null],
      ["/auth/login/", null],
    ] as const) {
      expect(ownedPageKind(path), path).toBe(kind);
    }
  });
});
