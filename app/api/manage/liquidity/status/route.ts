import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { bridgeStatus } from "@/lib/bridge-status";

// GET /api/manage/liquidity/status: the Liquidity screen's badge (owner 2026-10-23). Any staff of the broker; plain
// words only ("Connected" / "Degraded" / "Not connected"), when it last changed, and when the bridge last reported.
// No LP names or connection internals (those are Super Admin telemetry).
export async function GET() {
  const session = await getAdminSession();
  if (!session?.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await bridgeStatus(session.brokerId));
}
