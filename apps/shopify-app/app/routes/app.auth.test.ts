import { describe, expect, it, vi } from "vitest";

// Avoid touching prisma/dev.sqlite from the real db.server singleton.
vi.mock("../db.server", async () => {
  const { createTestDb } = await import("../testing/helpers.server");
  return { default: await createTestDb() };
});

import { loader } from "./app";

// AC-5: a request with no session token must never reach route logic — the
// auth library throws its redirect/401 response before the loader body runs.
describe("authenticated app routes", () => {
  it("rejects an invalid session token with 401 before route logic runs", async () => {
    let thrown: unknown;
    let result: unknown;
    try {
      result = await loader({
        request: new Request("https://test-app.example.com/app", {
          headers: { Authorization: "Bearer not-a-valid-session-token" },
        }),
        params: {},
        context: {},
      } as never);
    } catch (error) {
      thrown = error;
    }

    // The loader body (which would return { apiKey }) never executed.
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  it("never runs route logic for a session-token-less document request", async () => {
    let thrown: unknown;
    let result: unknown;
    try {
      result = await loader({
        request: new Request("https://test-app.example.com/app"),
        params: {},
        context: {},
      } as never);
    } catch (error) {
      thrown = error;
    }

    // The auth library intercepts with a thrown response (a token-acquisition
    // bounce page or redirect) — the loader body never returns its data.
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(Response);
  });
});
