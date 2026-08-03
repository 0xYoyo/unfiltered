import type { PrismaClient } from "@prisma/client";

export interface GroupTotals {
  key: string;
  calls: number;
  costUsd: number;
}

export interface CostAggregates {
  totalCalls: number;
  totalCostUsd: number;
  byModel: GroupTotals[];
  byOperation: GroupTotals[];
  /** One entry per search ID, totalling every ledger row sharing it. */
  perSearch: GroupTotals[];
  /** Mean cost across the searches in perSearch; null when there are none. */
  avgCostPerSearchUsd: number | null;
}

/** Aggregate the AI-call ledger for the internal cost admin. */
export async function aggregateCosts(db: PrismaClient): Promise<CostAggregates> {
  const [totals, byModel, byOperation, perSearch] = await Promise.all([
    db.aiCall.aggregate({ _count: true, _sum: { costUsd: true } }),
    db.aiCall.groupBy({
      by: ["modelId"],
      _count: true,
      _sum: { costUsd: true },
      orderBy: { modelId: "asc" },
    }),
    db.aiCall.groupBy({
      by: ["operation"],
      _count: true,
      _sum: { costUsd: true },
      orderBy: { operation: "asc" },
    }),
    db.aiCall.groupBy({
      by: ["searchId"],
      where: { searchId: { not: null } },
      _count: true,
      _sum: { costUsd: true },
      orderBy: { searchId: "asc" },
    }),
  ]);

  const perSearchTotals = perSearch.map((group) => ({
    key: group.searchId as string,
    calls: group._count,
    costUsd: group._sum.costUsd ?? 0,
  }));

  return {
    totalCalls: totals._count,
    totalCostUsd: totals._sum.costUsd ?? 0,
    byModel: byModel.map((group) => ({
      key: group.modelId,
      calls: group._count,
      costUsd: group._sum.costUsd ?? 0,
    })),
    byOperation: byOperation.map((group) => ({
      key: group.operation,
      calls: group._count,
      costUsd: group._sum.costUsd ?? 0,
    })),
    perSearch: perSearchTotals,
    avgCostPerSearchUsd:
      perSearchTotals.length === 0
        ? null
        : perSearchTotals.reduce((sum, s) => sum + s.costUsd, 0) /
          perSearchTotals.length,
  };
}
