import { describe, expect, it } from "vitest";

import { loader } from "./healthz";

// Exercises the /healthz loader, which needs no Shopify session or network:
// it only proves the app is wired to the engine package's public API.
describe("healthz loader", () => {
  it("returns ok with the engine's typed empty search result", async () => {
    const response = await loader();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      engine: {
        version: "0.3.0",
        search: {
          hits: [],
          totalCount: 0,
          query: "healthcheck",
        },
      },
    });
  });
});
