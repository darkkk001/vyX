import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getRiskRadarPayload } from "@/lib/risk-radar-cache";
import { applyRiskMarks, loadRiskMarks } from "@/lib/risk-marks";
import { prisma } from "@/lib/prisma";

// Impression Pack #4 -- "computed server-side on demand with a 5-min cache," per spec. The cache lives in
// lib/risk-radar-cache.ts (shared with GET /api/manage/badges' RDR count since 2026-10-05).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // step 3b item 6: staff's flag / whitelist / note per account, applied at read time (the radar itself stays cached)
  const payload = await getRiskRadarPayload(session!.brokerId!);
  return NextResponse.json(applyRiskMarks(payload, await loadRiskMarks(prisma, session!.brokerId!)));
}
