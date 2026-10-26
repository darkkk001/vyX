import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { marginPassGate } from "@/lib/live-price";
import { recordEquitySnapshots } from "@/lib/equity-snapshots";

// bo 1.0.96 #21 (owner 2026-10-27): the 5-minute equity history (lib/equity-snapshots.ts). Vercel cron, CRON_SECRET like
// margin-monitor. Same idle gate: with no fresh tick on any symbol no floating P/L can be valued, so nothing is written
// (and the equity of every open account is unchanged anyway).
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const gate = await marginPassGate();
  if (gate.run === false) return NextResponse.json({ skipped: gate.reason, written: 0 });
  return NextResponse.json(await recordEquitySnapshots());
}
