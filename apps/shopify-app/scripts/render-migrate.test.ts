import { describe, expect, it } from "vitest";

import { poolDatabaseUrl, PoolUrlError } from "./render-migrate.mjs";

// The pooled-URL rewrite behind `pool-database-url` (YOY-115 AC-5): the
// only part of the Render helper that can be proven offline. Everything
// else in that script talks to the Render API with a real key.

describe("poolDatabaseUrl", () => {
  const direct =
    "postgresql://neondb_owner:s3cr3t@ep-quiet-sun-a2b3c4d5.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  it("inserts -pooler after the endpoint id and adds pgbouncer=true, keeping everything else", () => {
    expect(poolDatabaseUrl(direct)).toBe(
      "postgresql://neondb_owner:s3cr3t@ep-quiet-sun-a2b3c4d5-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&pgbouncer=true",
    );
  });

  it("does not duplicate pgbouncer=true when it is already there", () => {
    const pooled = poolDatabaseUrl(`${direct}&pgbouncer=true`);
    expect(pooled.match(/pgbouncer=true/g)).toHaveLength(1);
    expect(pooled).toContain("-pooler.eu-central-1");
  });

  it("refuses a URL that is already pooled", () => {
    expect(() => poolDatabaseUrl(poolDatabaseUrl(direct))).toThrow(PoolUrlError);
    expect(() => poolDatabaseUrl(poolDatabaseUrl(direct))).toThrow(/already uses the pooled/);
  });

  it("refuses a host that is not a Neon endpoint, and a non-URL", () => {
    expect(() =>
      poolDatabaseUrl("postgresql://postgres:pw@localhost:5432/unfiltered"),
    ).toThrow(PoolUrlError);
    expect(() => poolDatabaseUrl("not a url")).toThrow(PoolUrlError);
  });
});
