import { createHash, timingSafeEqual } from "node:crypto";

import { useLoaderData } from "react-router";

import type { CostAggregates, GroupTotals } from "../ai/cost-aggregates.server";
import { aggregateCosts } from "../ai/cost-aggregates.server";
import db from "../db.server";

// Internal, non-embedded cost admin. Token-gated: without the exact
// ADMIN_TOKEN this route is indistinguishable from a nonexistent one.

const notFound = () => new Response("Not Found", { status: 404 });

function tokenMatches(presented: string | null, expected: string | undefined) {
  if (!presented || !expected) {
    return false;
  }
  // Hashing first makes the buffers equal-length, keeping the comparison
  // constant-time for tokens of any length.
  const presentedDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export const loader = async ({ request }: { request: Request }) => {
  const token = new URL(request.url).searchParams.get("token");
  if (!tokenMatches(token, process.env.ADMIN_TOKEN)) {
    throw notFound();
  }
  return aggregateCosts(db);
};

const usd = (value: number) => `$${value.toFixed(6)}`;

function TotalsTable({ title, rows }: { title: string; rows: GroupTotals[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>{title}</th>
            <th>Calls</th>
            <th>Cost (USD)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              <td>{row.calls}</td>
              <td>{usd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function InternalCosts() {
  const aggregates = useLoaderData<CostAggregates>();

  return (
    <main style={{ fontFamily: "monospace", padding: "1rem" }}>
      <h1>AI cost ledger</h1>
      <p>
        Total: {aggregates.totalCalls} calls, {usd(aggregates.totalCostUsd)}
      </p>
      <TotalsTable title="Model" rows={aggregates.byModel} />
      <TotalsTable title="Operation" rows={aggregates.byOperation} />
      <TotalsTable title="Search" rows={aggregates.perSearch} />
      <p>
        Cost per search (mean):{" "}
        {aggregates.avgCostPerSearchUsd === null
          ? "n/a"
          : usd(aggregates.avgCostPerSearchUsd)}
      </p>
    </main>
  );
}
