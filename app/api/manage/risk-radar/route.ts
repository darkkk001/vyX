import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeRiskRadar, type RiskRadarRow } from "@/lib/risk-radar";

// Impression Pack #4 -- "computed server-side on demand with a 5-min
// cache," per spec. A plain module-scope Map is enough: this route runs
// on a single Next.js server process (no multi-instance deployment
// today), and a stale-by-up-to-5-minutes risk table is explicitly
// acceptable per spec, not a correctness concern worth a real cache
// layer (Redis etc.) for v1.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { rows: RiskRadarRow[]; expiresAt: number }>();

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const brokerId = session!.brokerId!;
  const cached = cache.get(brokerId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.rows);
  }

  const rows = await computeRiskRadar(prisma, brokerId);
  cache.set(brokerId, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(rows);
}
