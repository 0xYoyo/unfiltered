import type { Session } from "@shopify/shopify-app-react-router/server";

/**
 * In-memory Shopify session storage, used only under fixture mode
 * (YOY-92 AC-8).
 *
 * `PrismaSessionStorage` counts rows in the session table as it boots and
 * exits the process when it cannot reach the database. That is right in
 * production — an app that cannot persist sessions is broken — but it means
 * the UI lane could not boot the built app without a Postgres, and the lane
 * exists precisely to run without one. The playground pages never
 * authenticate, so nothing in the lane ever reads or writes a session; this
 * implementation satisfies the interface and forgets everything.
 *
 * It is unreachable outside fixture mode: `shopify.server.ts` selects it
 * only when `PLAYGROUND_FIXTURES=1`.
 *
 * The return type is inferred rather than annotated with the library's
 * `SessionStorage`: that interface lives in `@shopify/shopify-app-session-
 * storage`, which reaches this app only as a transitive dependency, and
 * `shopifyApp` accepts the shape structurally.
 */
export function createFixtureSessionStorage() {
  const sessions = new Map<string, Session>();

  return {
    async storeSession(session: Session) {
      sessions.set(session.id, session);
      return true;
    },
    async loadSession(id: string) {
      return sessions.get(id);
    },
    async deleteSession(id: string) {
      sessions.delete(id);
      return true;
    },
    async deleteSessions(ids: string[]) {
      for (const id of ids) {
        sessions.delete(id);
      }
      return true;
    },
    async findSessionsByShop(shop: string) {
      return [...sessions.values()].filter((session) => session.shop === shop);
    },
  };
}
