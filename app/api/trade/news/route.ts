import { NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { getEconomicCalendar } from "@/lib/economic-calendar-source";
import type { CalendarEvent } from "@/lib/economic-calendar";

// VYX-CALENDAR-FALLBACK-V0 -- ForexFactory's free weekly feed
// (lib/economic-calendar-source.ts) is now the primary source, DB-cached
// for 1h. Finnhub stays wired as a secondary attempt ONLY if a key is
// configured AND ForexFactory's fetch fails with no cache to fall back
// on -- this deployment's own key doesn't have calendar access (a
// confirmed 403 plan-tier limitation, not a bad key -- see the comment
// below), so in practice this path is dormant here, but exists for any
// broker that later adds a paid Finnhub key (a real per-broker adapter
// choice is Phase 2 -- see this route's own history).
//
// CONFIRMED (2026-09-02): the configured FINNHUB_API_KEY gets a real 403
// "You don't have access to this resource" directly from Finnhub on
// /calendar/economic, verified with `curl` straight against Finnhub,
// independent of this app entirely. Rotating the key will not fix it.
async function fetchFinnhubFallback(): Promise<CalendarEvent[] | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;
  const from = new Date();
  const to = new Date(from.getTime() + 3 * 86_400_000);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const raw = Array.isArray(data?.economicCalendar) ? data.economicCalendar : [];
    return raw
      .map((e: Record<string, unknown>) => ({
        time: String(e.time ?? ""),
        country: String(e.country ?? ""),
        event: String(e.event ?? ""),
        impact: String(e.impact ?? "low").toLowerCase(),
        actual: (e.actual as string | number | null) ?? null,
        estimate: (e.estimate as string | number | null) ?? null,
        previous: (e.prev as string | number | null) ?? null,
      }))
      .slice(0, 40);
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  try {
    const { events } = await getEconomicCalendar();
    return NextResponse.json(events);
  } catch (err) {
    console.warn("[trade/news] ForexFactory fallback failed too", err instanceof Error ? err.message : err);
    const finnhubEvents = await fetchFinnhubFallback();
    if (finnhubEvents) return NextResponse.json(finnhubEvents);
    return NextResponse.json({ error: "news feed unavailable" }, { status: 503 });
  }
}
