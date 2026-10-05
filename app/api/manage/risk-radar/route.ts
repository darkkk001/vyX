import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getRiskRadarPayload } from "@/lib/risk-radar-cache";

// Impression Pack #4 -- "computed server-side on demand with a 5-min cache," per spec. The cache lives in
// lib/risk-radar-cache.ts (shared with GET /api/manage/badges' RDR count since 2026-10-05).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(await getRiskRadarPayload(session!.brokerId!));
}
