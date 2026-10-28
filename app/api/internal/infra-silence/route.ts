import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { checkInfraSilence } from "@/lib/infra-health";

// The silence alert for the VPS infra checks (owner 2026-10-28, lib/infra-health.ts checkInfraSilence): ONE ops e-mail
// when a check that used to report has sent nothing for 15 minutes. Vercel cron every 5 minutes, CRON_SECRET like
// margin-monitor. Redis only, no database read, so it never wakes Neon.
export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ checked: await checkInfraSilence() });
}
