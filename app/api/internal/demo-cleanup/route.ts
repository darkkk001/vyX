import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { runDemoCleanup } from "@/lib/demo-cleanup";

// Daily Vercel cron (vercel.json): replays the QoreTrader demo's guests that still hold positions or resting orders, then deletes
// guests with no login and no order for 7 days (or older than 30 days). Same bearer-secret shape as the other crons
// (Authorization: Bearer CRON_SECRET). `?dryRun=1` counts and deletes nothing. A deployment without DEMO_BROKER_SUBDOMAIN
// answers with an empty summary.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";
  const summary = await runDemoCleanup({ dryRun });
  return NextResponse.json(summary);
}
