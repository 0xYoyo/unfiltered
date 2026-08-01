import { createEngine, version as engineVersion } from "@unfiltered/engine";

// Unauthenticated health/debug endpoint proving the app is wired to the
// engine package through its public API.
export const loader = async () => {
  const engine = createEngine();
  const result = await engine.search("healthcheck", { limit: 1 });

  return Response.json({
    status: "ok",
    engine: {
      version: engineVersion,
      search: result,
    },
  });
};
