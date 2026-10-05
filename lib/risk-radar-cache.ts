import "server-only";
import { prisma } from "@/lib/prisma";
import { computeRiskRadar, computeSameIpClusters, type RiskRadarRow, type SameIpCluster, type NewsHistoryStatus } from "@/lib/risk-radar";
import { newsHistoryFrom } from "@/lib/economic-events";

// Impression Pack #4 -- "computed server-side on demand with a 5-min
// cache," per spec. A plain module-scope Map is enough: a stale-by-up-to-5-
// minutes risk table is explicitly acceptable per spec, not a correctness
// concern worth a real cache layer (Redis etc.) for v1. Note the Map is per
// server instance (each Vercel function instance keeps its own).
//
// Moved out of app/api/manage/risk-radar/route.ts (2026-10-05) so GET
// /api/manage/badges reads the SAME cache for its RDR count instead of
// recomputing the radar per call. A computation already in flight for a broker
// is shared too: concurrent cold callers wait on one compute, not one each.
const CACHE_TTL_MS = 5 * 60 * 1000;
export type RiskRadarPayload = { rows: RiskRadarRow[]; sameIpClusters: SameIpCluster[]; newsHistory: NewsHistoryStatus; computedAt: string };
const cache = new Map<string, { payload: RiskRadarPayload; expiresAt: number }>();
const inFlight = new Map<string, Promise<RiskRadarPayload>>();

async function computePayload(brokerId: string): Promise<RiskRadarPayload> {
  // Same-IP multi-account detection (Risk Radar) -- a separate, cross-
  // account query from the per-account rows, computed alongside them and
  // cached under the same 5-min TTL.
  const [rows, sameIpClusters, historyFrom] = await Promise.all([
    computeRiskRadar(prisma, brokerId),
    computeSameIpClusters(prisma, brokerId),
    newsHistoryFrom(prisma),
  ]);
  // web4: how far back the news-trading flag can look (the event history starts at the web4 deploy)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const newsHistory: NewsHistoryStatus = historyFrom
    ? { historyFrom: historyFrom.toISOString(), windowFrom: (historyFrom > since ? historyFrom : since).toISOString(), collectingHistory: historyFrom > since }
    : { historyFrom: null, windowFrom: null, collectingHistory: true };
  // web5 (issues.md 328): when these numbers were computed (the 5-minute cache serves the same time until it expires)
  return { rows, sameIpClusters, newsHistory, computedAt: new Date().toISOString() };
}

/** The broker's risk radar, from the 5-minute cache (computed on a miss, once even for concurrent callers). */
export async function getRiskRadarPayload(brokerId: string): Promise<RiskRadarPayload> {
  const cached = cache.get(brokerId);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  const pending = inFlight.get(brokerId);
  if (pending) return pending;
  const p = computePayload(brokerId)
    .then((payload) => {
      cache.set(brokerId, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
      return payload;
    })
    .finally(() => inFlight.delete(brokerId));
  inFlight.set(brokerId, p);
  return p;
}

/** A radar row is flagged when any of its four behaviour flags is set (the backoffice's FlagCount > 0). */
export function riskRadarFlagCount(r: RiskRadarRow): number {
  return (r.scalpFlag ? 1 : 0) + (r.martingaleFlag ? 1 : 0) + (r.latencyArbFlag ? 1 : 0) + (r.newsTraderFlag ? 1 : 0);
}

/** The RDR badge: flagged accounts + same-IP clusters (exactly what the backoffice counted from the full payload). */
export function riskRadarBadgeCount(payload: RiskRadarPayload): number {
  return payload.rows.filter((r) => riskRadarFlagCount(r) > 0).length + payload.sameIpClusters.length;
}

/** Test-only: forget every cached payload. */
export function clearRiskRadarCacheForTests() {
  cache.clear();
  inFlight.clear();
}
