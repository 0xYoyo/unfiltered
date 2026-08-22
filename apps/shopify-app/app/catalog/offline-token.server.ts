import type { PrismaClient } from "@prisma/client";

/**
 * Offline Admin API access for unattended jobs (YOY-98).
 *
 * The app requests EXPIRING offline access tokens (`future.
 * expiringOfflineAccessTokens` in shopify.server.ts — mandatory for public
 * apps created after 2026-04-01 and for every public app from 2027-01-01):
 * the token in the offline `Session` row lives 60 minutes and comes with a
 * 90-day refresh token. Inside the embedded app the library refreshes it on
 * every authenticated request; an unattended job reading the row directly
 * (`npm run ingest`) must do the same refresh itself, or it dies within an
 * hour of the last admin interaction — the symptom this module fixes.
 *
 * `resolveOfflineAccessToken` returns a token that is valid now: the stored
 * one when it is non-expiring or still fresh, otherwise a refreshed one,
 * persisted back to the row so the next job (and the app) reuse it. When no
 * usable token can be produced it throws `OfflineAuthError`, whose message
 * names the shop and the fix — never a raw API error dump (AC-2).
 */

/** Refresh when the stored token expires within this window. */
export const REFRESH_WITHIN_MS = 5 * 60 * 1000;

const OAUTH_API_VERSION_FREE_PATH = "/admin/oauth/access_token";

/** The re-authorization instruction, once, for every failure path. */
export function reauthorizeHint(shop: string): string {
  return `re-authorize ${shop}: npm run dev → open the app in the store admin (a fresh install writes a new offline session)`;
}

/** An unattended job cannot authenticate to the Admin API for `shop`. */
export class OfflineAuthError extends Error {
  readonly shop: string;
  constructor(shop: string, reason: string) {
    super(
      `cannot authenticate to ${shop}: ${reason} — ${reauthorizeHint(shop)}`,
    );
    this.name = "OfflineAuthError";
    this.shop = shop;
  }
}

/** The shape of Shopify's access-token response for the refresh grant. */
interface RefreshTokenResponse {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface ResolveOfflineTokenOptions {
  db: PrismaClient;
  shop: string;
  /** App credentials for the refresh grant (SHOPIFY_API_KEY / _SECRET). */
  apiKey: string;
  apiSecretKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * A currently valid offline access token for `shop`, refreshing and
 * persisting when the stored one is expired or about to expire.
 */
export async function resolveOfflineAccessToken({
  db,
  shop,
  apiKey,
  apiSecretKey,
  fetch: fetchImpl = fetch,
  now = () => new Date(),
}: ResolveOfflineTokenOptions): Promise<string> {
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
  });
  if (session === null) {
    throw new OfflineAuthError(shop, "no offline session stored for this shop");
  }
  const currentTime = now().getTime();
  // Non-expiring token, or an expiring one with time to spare: use as is.
  if (
    session.expires === null ||
    session.expires.getTime() - currentTime > REFRESH_WITHIN_MS
  ) {
    return session.accessToken;
  }
  const expiredAt = session.expires.toISOString();
  if (session.refreshToken === null || session.refreshToken === "") {
    throw new OfflineAuthError(
      shop,
      `the offline access token expired at ${expiredAt} and no refresh token is stored`,
    );
  }
  if (
    session.refreshTokenExpires !== null &&
    session.refreshTokenExpires.getTime() <= currentTime
  ) {
    throw new OfflineAuthError(
      shop,
      `the offline access token expired at ${expiredAt} and its refresh token expired at ${session.refreshTokenExpires.toISOString()}`,
    );
  }
  // The refresh grant needs the app credentials. Posting empty ones gets a
  // 4xx from Shopify whose only suggested fix would be re-authorizing — which
  // does not set an env var (YOY-96 AC-2). Name the missing variable instead,
  // before any network call.
  const missingCredentials = [
    ...(apiKey.trim() === "" ? ["SHOPIFY_API_KEY"] : []),
    ...(apiSecretKey.trim() === "" ? ["SHOPIFY_API_SECRET"] : []),
  ];
  if (missingCredentials.length > 0) {
    const plural = missingCredentials.length > 1;
    throw new OfflineAuthError(
      shop,
      `the offline access token expired at ${expiredAt} and ${missingCredentials.join(" / ")} ${plural ? "are" : "is"} not set, so it cannot be refreshed — set ${plural ? "them" : "it"} in .env (re-authorizing does not set ${plural ? "them" : "it"})`,
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `https://${shop}${OAUTH_API_VERSION_FREE_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecretKey,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        }),
      },
    );
  } catch (error) {
    throw new OfflineAuthError(
      shop,
      `refreshing the expired offline access token failed (${
        error instanceof Error ? error.message : "network error"
      })`,
    );
  }
  if (!response.ok) {
    throw new OfflineAuthError(
      shop,
      `refreshing the expired offline access token was rejected (HTTP ${response.status})`,
    );
  }
  let body: RefreshTokenResponse;
  try {
    body = (await response.json()) as RefreshTokenResponse;
  } catch {
    throw new OfflineAuthError(
      shop,
      "refreshing the expired offline access token returned a malformed response",
    );
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new OfflineAuthError(
      shop,
      "refreshing the expired offline access token returned no access token",
    );
  }
  const refreshedAt = now().getTime();
  await db.session.update({
    where: { id: session.id },
    data: {
      accessToken: body.access_token,
      scope: typeof body.scope === "string" ? body.scope : session.scope,
      expires:
        typeof body.expires_in === "number"
          ? new Date(refreshedAt + body.expires_in * 1000)
          : null,
      // Shopify rotates the refresh token with every refresh; a response
      // without one keeps the stored token (it stays valid until used).
      ...(typeof body.refresh_token === "string" &&
      typeof body.refresh_token_expires_in === "number"
        ? {
            refreshToken: body.refresh_token,
            refreshTokenExpires: new Date(
              refreshedAt + body.refresh_token_expires_in * 1000,
            ),
          }
        : {}),
    },
  });
  return body.access_token;
}

/**
 * Wrap an Admin API fetch so an authentication rejection surfaces as an
 * `OfflineAuthError` (AC-2) instead of a raw API error further down: the
 * Admin API answers 401 to an invalid or expired access token.
 */
export async function rejectUnauthenticated(
  shop: string,
  response: Response,
): Promise<Response> {
  if (response.status === 401) {
    throw new OfflineAuthError(
      shop,
      "the Admin API rejected the stored access token (401)",
    );
  }
  return response;
}
