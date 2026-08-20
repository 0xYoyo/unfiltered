import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route the loader at a throwaway test DB, exactly as the playground API
// tests do — the point of this suite is that the loader reads the real
// PlaygroundCatalog table, not the fixture registry.
vi.mock("./db.server", async () => {
  const { createTestDb } = await import("./testing/helpers.server");
  return { default: await createTestDb() };
});

import db from "./db.server";
import { loader } from "./routes/s.$slug";

/**
 * The store-preload loader (YOY-94 AC-1): a known slug resolves to the
 * catalog's name and product count; an unknown one answers 404 rather than
 * falling back to the seed. Falling back would be the dangerous failure —
 * an outreach link with a typo would silently demo the wrong catalog.
 */

const ORIGINAL_ENV = { ...process.env };

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const args = (url: string, slug: string, headers: Record<string, string> = {}) =>
  ({
    request: request(url, headers),
    params: { slug },
    context: {},
  }) as never;

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  // Fixture mode must be off: these assertions are about the database path.
  delete process.env.PLAYGROUND_FIXTURES;
  await db.playgroundCatalog.deleteMany();
  await db.playgroundCatalog.create({
    data: {
      slug: "aurora",
      name: "Aurora Atelier",
      storeKey: "playground:aurora",
      sourceUrl: "https://aurora.example.com",
      sourceKind: "shopify-public",
      productCount: 214,
    },
  });
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await db.playgroundCatalog.deleteMany();
});

describe("a known slug", () => {
  it("resolves the catalog's name and product count", async () => {
    const data = await loader(args("https://x.test/s/aurora", "aurora"));

    expect(data.slug).toBe("aurora");
    expect(data.store).toEqual({
      name: "Aurora Atelier",
      productCount: 214,
    });
  });

  it("resolves the chrome language exactly as / does", async () => {
    expect(
      (await loader(args("https://x.test/s/aurora?lang=he", "aurora"))).locale,
    ).toBe("he");
    expect(
      (
        await loader(
          args("https://x.test/s/aurora", "aurora", {
            "Accept-Language": "he-IL,he;q=0.9",
          }),
        )
      ).locale,
    ).toBe("he");
    expect(
      (await loader(args("https://x.test/s/aurora", "aurora"))).locale,
    ).toBe("en");
  });

  it("carries the query and the details flag through, as / does", async () => {
    const data = await loader(
      args("https://x.test/s/aurora?query=dress&details=1", "aurora"),
    );
    expect(data.initialQuery).toBe("dress");
    expect(data.detailsOpen).toBe(true);
    expect(data.pathname).toBe("/s/aurora");
  });
});

describe("an unknown slug", () => {
  it("throws a 404 rather than falling back to the seed catalog", async () => {
    // The fallback is the failure that matters: an outreach link with a
    // typo would otherwise demo somebody else's catalog under their name.
    process.env.PLAYGROUND_SEED_STORE_KEY = "playground:seed";

    await expect(
      loader(args("https://x.test/s/nope", "nope")),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s an empty slug too", async () => {
    await expect(
      loader(args("https://x.test/s/", "")),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("does not leak another catalog's row through a partial match", async () => {
    await expect(
      loader(args("https://x.test/s/auror", "auror")),
    ).rejects.toMatchObject({ status: 404 });
  });
});
