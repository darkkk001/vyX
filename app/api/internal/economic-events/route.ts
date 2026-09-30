import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEconomicCalendar } from "@/lib/economic-calendar-source";
import { recordHighImpactEvents } from "@/lib/economic-events";

// web4 (issues.md 151, owner 2026-09-30): Vercel Cron every 6 hours (vercel.json) so the high-impact event history
// keeps growing even in a week nobody opens the calendar (the calendar itself only refreshes when a trader reads it).
// Reads the week through the normal cached calendar and records its high-impact events (idempotent). Same bearer
// CRON_SECRET check as app/api/internal/swap-rollover.
export async function GET(request: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET ?? "";
  const auth = request.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!expectedSecret || provided !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { events, source } = await getEconomicCalendar();
  const recorded = await recordHighImpactEvents(prisma, events);
  return NextResponse.json({ source, events: events.length, highImpactRecorded: recorded });
}
