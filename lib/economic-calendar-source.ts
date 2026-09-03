import "server-only";
import { prisma } from "@/lib/prisma";
import type { CalendarEvent } from "./economic-calendar";

// VYX-CALENDAR-FALLBACK-V0 -- Finnhub's economic calendar isn't included
// in this deployment's configured key/plan tier (confirmed with a direct
// curl against Finnhub itself; see app/api/trade/news/route.ts's own
// comment for the diagnosis). This is the free fallback: ForexFactory's
// own weekly JSON feed, unofficial but widely relied on (no auth, no
// documented rate limit, real economic-calendar data). Kept behind the
// same CalendarEvent shape everything else in this app already expects,
// so lib/economic-calendar.ts's currency-matching/high-impact-soon logic
// and every UI consumer (NewsPanel, the chart markers, the order
// ticket's warning chip) needs zero changes.
const FOREXFACTORY_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_TTL_MS = 60 * 60_000; // 1h, per the brief
const CACHE_ID = "forexfactory";

type ForexFactoryRow = {
  title?: unknown;
  country?: unknown;
  date?: unknown;
  impact?: unknown;
  forecast?: unknown;
  previous?: unknown;
};

async function fetchForexFactory(): Promise<CalendarEvent[]> {
  const res = await fetch(FOREXFACTORY_URL, {
    // A default fetch User-Agent has been enough in testing, but an
    // explicit one is cheap insurance against a host that blankly
    // blocks anything that looks like a bare script.
    headers: { "User-Agent": "Mozilla/5.0 (compatible; vyXTraderCalendar/1.0; +https://vyxtrader.com)" },
  });
  if (!res.ok) throw new Error(`ForexFactory calendar request failed: ${res.status}`);
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new Error("ForexFactory calendar returned an unexpected shape (not an array)");

  const events: CalendarEvent[] = [];
  for (const row of raw as ForexFactoryRow[]) {
    // "Holiday" entries are market-closure notices, not tradeable
    // events -- excluded rather than surfaced as a confusing chart
    // marker/ticket warning.
    if (String(row.impact ?? "").toLowerCase() === "holiday") continue;
    const time = new Date(String(row.date ?? ""));
    if (Number.isNaN(time.getTime())) continue;
    events.push({
      time: time.toISOString(),
      country: String(row.country ?? ""),
      event: String(row.title ?? ""),
      impact: String(row.impact ?? "low").toLowerCase(),
      // This free feed never carries a realized value, even for an
      // event that's already happened -- "—" (never a fabricated
      // number) is the honest call here, same "never show a wrong
      // number" rule the rest of this app already follows.
      actual: null,
      estimate: (row.forecast as string | null) || null,
      previous: (row.previous as string | null) || null,
    });
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return events;
}

export type CalendarFetchResult = { events: CalendarEvent[]; source: "forexfactory" | "forexfactory-cached" | "forexfactory-stale" };

// DB-backed (not module-scope memory -- see EconomicCalendarCache's own
// schema comment on why that matters on Vercel), 1h TTL. On a fetch
// failure with an existing (even stale) cache row, serves the stale data
// rather than nothing -- graceful degradation, same philosophy as the
// rest of this app's live-feed handling, rather than a hard failure over
// a transient upstream hiccup once real data has been seen at least once.
export async function getEconomicCalendar(): Promise<CalendarFetchResult> {
  const cached = await prisma.economicCalendarCache.findUnique({ where: { id: CACHE_ID } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return { events: cached.events as unknown as CalendarEvent[], source: "forexfactory-cached" };
  }

  try {
    const events = await fetchForexFactory();
    await prisma.economicCalendarCache.upsert({
      where: { id: CACHE_ID },
      create: { id: CACHE_ID, events: events as unknown as object, fetchedAt: new Date() },
      update: { events: events as unknown as object, fetchedAt: new Date() },
    });
    return { events, source: "forexfactory" };
  } catch (err) {
    console.warn("[economic-calendar] ForexFactory fetch failed", err instanceof Error ? err.message : err);
    if (cached) {
      return { events: cached.events as unknown as CalendarEvent[], source: "forexfactory-stale" };
    }
    throw err;
  }
}
