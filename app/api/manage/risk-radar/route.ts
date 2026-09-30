import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeRiskRadar, computeSameIpClusters, type RiskRadarRow, type SameIpCluster, type NewsHistoryStatus } from "@/lib/risk-radar";
import { newsHistoryFrom } from "@/lib/economic-events";

// Impression Pack #4 -- "computed server-side on demand with a 5-min
// cache," per spec. A plain module-scope Map is enough: this route runs
// on a single Next.js server process (no multi-instance deployment
// today), and a stale-by-up-to-5-minutes risk table is explicitly
// acceptable per spec, not a correctness concern worth a real cache
// layer (Redis etc.) for v1.
const CACHE_TTL_MS = 5 * 60 * 1000;
type CachedPayload = { rows: RiskRadarRow[]; sameIpClusters: SameIpCluster[]; newsHistory: NewsHistoryStatus };
const cache = new Map<string, { payload: CachedPayload; expiresAt: number }>();

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const brokerId = session!.brokerId!;
  const cached = cache.get(brokerId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload);
  }

  // Same-IP multi-account detection (Risk Radar) -- a separate, cross-
  // account query from the per-account rows above, computed alongside
  // them and cached under the same 5-min TTL.
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
  const payload: CachedPayload = { rows, sameIpClusters, newsHistory };
  cache.set(brokerId, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(payload);
}
