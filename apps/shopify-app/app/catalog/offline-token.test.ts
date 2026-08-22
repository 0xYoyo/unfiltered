import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  OfflineAuthError,
  REFRESH_WITHIN_MS,
  rejectUnauthenticated,
  resolveOfflineAccessToken,
} from "./offline-token.server";
import { createTestDb } from "../testing/helpers.server";

// Unattended offline auth (YOY-98): the offline Session row holds a
// 60-minute expiring access token plus a refresh token; a job reading the
// row must refresh when expired, persist the result, and fail loudly with
// the re-authorize instruction when it cannot.

const SHOP = "test-shop.myshopify.com";
const NOW = new Date("2026-08-16T12:00:00Z");
const now = () => NOW;

let db: PrismaClient;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
  captured: CapturedRequest[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    captured.push(request);
    return respond(request);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function seedSession(overrides: {
  accessToken?: string;
  expires?: Date | null;
  refreshToken?: string | null;
  refreshTokenExpires?: Date | null;
}) {
  return db.session.create({
    data: {
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "",
      isOnline: false,
      scope: "write_products",
      accessToken: overrides.accessToken ?? "shpua_expiring",
      expires: overrides.expires === undefined ? null : overrides.expires,
      refreshToken:
        overrides.refreshToken === undefined ? null : overrides.refreshToken,
      refreshTokenExpires:
        overrides.refreshTokenExpires === undefined
          ? null
          : overrides.refreshTokenExpires,
    },
  });
}

const resolve = (fetchImpl: typeof fetch) =>
  resolveOfflineAccessToken({
    db,
    shop: SHOP,
    apiKey: "app-key",
    apiSecretKey: "app-secret",
    fetch: fetchImpl,
    now,
  });

const neverFetch = fakeFetch(() => {
  throw new Error("fetch must not be called");
});

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await db.session.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("resolveOfflineAccessToken (AC-1)", () => {
  it("returns a non-expiring token as stored, without any network call", async () => {
    await seedSession({ accessToken: "shpat_forever", expires: null });
    await expect(resolve(neverFetch)).resolves.toBe("shpat_forever");
  });

  it("returns an expiring token that is still fresh, without refreshing", async () => {
    await seedSession({
      accessToken: "shpua_fresh",
      expires: new Date(NOW.getTime() + REFRESH_WITHIN_MS + 60_000),
      refreshToken: "refresh-1",
    });
    await expect(resolve(neverFetch)).resolves.toBe("shpua_fresh");
  });

  it("refreshes an expired token through the refresh grant and persists the rotated pair", async () => {
    await seedSession({
      accessToken: "shpua_dead",
      expires: new Date(NOW.getTime() - 60_000),
      refreshToken: "refresh-1",
      refreshTokenExpires: new Date(NOW.getTime() + 80 * 86_400_000),
    });
    const captured: CapturedRequest[] = [];
    const token = await resolve(
      fakeFetch(
        () =>
          json({
            access_token: "shpua_new",
            scope: "write_products,write_inventory",
            expires_in: 3600,
            refresh_token: "refresh-2",
            refresh_token_expires_in: 90 * 86_400,
          }),
        captured,
      ),
    );

    expect(token).toBe("shpua_new");
    // One POST to the shop's OAuth token endpoint, refresh grant, app creds.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(captured[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(captured[0]!.init?.body))).toEqual({
      client_id: "app-key",
      client_secret: "app-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
    // The row now carries the new token, expiry, scope, and rotated refresh
    // token — so the next job (and the embedded app) reuse them.
    const row = await db.session.findUniqueOrThrow({
      where: { id: `offline_${SHOP}` },
    });
    expect(row.accessToken).toBe("shpua_new");
    expect(row.expires).toEqual(new Date(NOW.getTime() + 3600_000));
    expect(row.scope).toBe("write_products,write_inventory");
    expect(row.refreshToken).toBe("refresh-2");
    expect(row.refreshTokenExpires).toEqual(
      new Date(NOW.getTime() + 90 * 86_400_000),
    );
    expect(row.isOnline).toBe(false);
  });

  it("refreshes a token that is about to expire (inside the refresh window)", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() + REFRESH_WITHIN_MS - 1000),
      refreshToken: "refresh-1",
    });
    const token = await resolve(
      fakeFetch(() =>
        json({ access_token: "shpua_new", scope: "s", expires_in: 3600 }),
      ),
    );
    expect(token).toBe("shpua_new");
  });
});

describe("failure paths name the shop and the fix (AC-2)", () => {
  const expectActionable = async (
    promise: Promise<unknown>,
    reason: RegExp,
  ) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OfflineAuthError);
    const message = (error as Error).message;
    expect(message).toContain(SHOP);
    expect(message).toMatch(reason);
    expect(message).toContain("re-authorize");
    expect(message).toContain("npm run dev");
    expect(message).toContain("open the app in the store admin");
  };

  it("no offline session", async () => {
    await expectActionable(resolve(neverFetch), /no offline session/);
  });

  it("expired token and no refresh token", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() - 1000),
      refreshToken: null,
    });
    await expectActionable(resolve(neverFetch), /no refresh token is stored/);
  });

  it("expired token and an expired refresh token", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() - 1000),
      refreshToken: "refresh-old",
      refreshTokenExpires: new Date(NOW.getTime() - 1000),
    });
    await expectActionable(resolve(neverFetch), /refresh token expired/);
  });

  it("expired token with a valid refresh token but no app credentials names the missing variables and makes no request (YOY-96 AC-2)", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() - 1000),
      refreshToken: "refresh-1",
    });
    const captured: CapturedRequest[] = [];
    const error = await resolveOfflineAccessToken({
      db,
      shop: SHOP,
      apiKey: "",
      apiSecretKey: "",
      fetch: fakeFetch(() => json({ error: "invalid_client" }, 401), captured),
      now,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OfflineAuthError);
    const message = (error as Error).message;
    expect(message).toContain("SHOPIFY_API_KEY");
    expect(message).toContain("SHOPIFY_API_SECRET");
    expect(message).toMatch(
      /cannot be refreshed — set them in \.env \(re-authorizing does not set them\)/,
    );
    // The standard hint still follows, but is no longer the only fix named.
    expect(message).toContain("re-authorize");
    expect(captured).toHaveLength(0);
    // One missing variable is named alone.
    const single = await resolveOfflineAccessToken({
      db,
      shop: SHOP,
      apiKey: "app-key",
      apiSecretKey: "   ",
      fetch: fakeFetch(() => json({}, 401), captured),
      now,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((single as Error).message).toMatch(
      /SHOPIFY_API_SECRET is not set, so it cannot be refreshed — set it in \.env/,
    );
    expect((single as Error).message).not.toContain("SHOPIFY_API_KEY");
    expect(captured).toHaveLength(0);
  });

  it("the refresh grant is rejected", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() - 1000),
      refreshToken: "revoked",
    });
    await expectActionable(
      resolve(fakeFetch(() => json({ error: "invalid_grant" }, 400))),
      /rejected \(HTTP 400\)/,
    );
    // The stored row is untouched by a failed refresh.
    const row = await db.session.findUniqueOrThrow({
      where: { id: `offline_${SHOP}` },
    });
    expect(row.accessToken).toBe("shpua_expiring");
    expect(row.refreshToken).toBe("revoked");
  });

  it("the refresh grant is unreachable", async () => {
    await seedSession({
      expires: new Date(NOW.getTime() - 1000),
      refreshToken: "refresh-1",
    });
    await expectActionable(
      resolve(
        fakeFetch(() => {
          throw new Error("ECONNREFUSED");
        }),
      ),
      /failed \(ECONNREFUSED\)/,
    );
  });

  it("the Admin API answers 401 to the token in use", async () => {
    await expectActionable(
      rejectUnauthenticated(SHOP, new Response(null, { status: 401 })),
      /rejected the stored access token \(401\)/,
    );
    // Any other status passes through untouched.
    const ok = new Response("{}", { status: 200 });
    await expect(rejectUnauthenticated(SHOP, ok)).resolves.toBe(ok);
  });
});
