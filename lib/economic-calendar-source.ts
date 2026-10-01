import "server-only";
import { prisma } from "@/lib/prisma";
import type { CalendarEvent } from "./economic-calendar";
import { recordHighImpactEvents } from "@/lib/economic-events";
import { runAfterResponse } from "@/lib/after-response";

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
// web6 (owner 2026-10-01, issue 18: calendar stuck on "LOADING..." then "0 EVENTS"): the upstream fetch had no timeout,
// so a slow ForexFactory held the trader's request past the terminal's 20 s client timeout. Now it gives up after
// FETCH_TIMEOUT_MS and the last good (even stale) cache is served; after a failed refresh this server instance waits
// RETRY_AFTER_FAIL_MS before trying ForexFactory again, so every reader in a ForexFactory outage is not made to wait.
// Next week's feed: ForexFactory publishes only the this-week file (ff_calendar_nextweek.json and its variants answer
// 404, checked 2026-10-01), so there is nothing to merge; the week rolls over when ForexFactory publishes the new one.
export const FETCH_TIMEOUT_MS = 8_000;
const RETRY_AFTER_FAIL_MS = 2 * 60_000;
let fetchTimeoutMs = FETCH_TIMEOUT_MS;
let lastFailureAt = 0;
/** Test helper: forget the in-memory "last refresh failed" backoff, and set the upstream timeout (default 8 s). */
export function resetCalendarSourceForTests(timeoutMs = FETCH_TIMEOUT_MS): void {
  lastFailureAt = 0;
  fetchTimeoutMs = timeoutMs;
}
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let raw: unknown;
  try {
    const res = await fetch(FOREXFACTORY_URL, {
      // A default fetch User-Agent has been enough in testing, but an
      // explicit one is cheap insurance against a host that blankly
      // blocks anything that looks like a bare script.
      headers: { "User-Agent": "Mozilla/5.0 (compatible; vyXTraderCalendar/1.0; +https://vyxtrader.com)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`ForexFactory calendar request failed: ${res.status}`);
    raw = await res.json();
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`ForexFactory calendar timed out after ${fetchTimeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const cachedEvents = Array.isArray(cached?.events) ? (cached.events as unknown as CalendarEvent[]) : null;
  if (cached && cachedEvents && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return { events: cachedEvents, source: "forexfactory-cached" };
  }
  // web6: a refresh failed moments ago on this instance -- serve the stale copy now instead of waiting on ForexFactory again
  if (cachedEvents && cachedEvents.length > 0 && Date.now() - lastFailureAt < RETRY_AFTER_FAIL_MS) {
    return { events: cachedEvents, source: "forexfactory-stale" };
  }

  try {
    const events = await fetchForexFactory();
    // web6: an empty week from upstream never replaces a good cache (a ForexFactory hiccup would otherwise blank every
    // trader's calendar for the next hour)
    if (events.length === 0) {
      if (cachedEvents && cachedEvents.length > 0) throw new Error("ForexFactory calendar returned no events; keeping the cached week");
      return { events, source: "forexfactory" };
    }
    await prisma.economicCalendarCache.upsert({
      where: { id: CACHE_ID },
      create: { id: CACHE_ID, events: events as unknown as object, fetchedAt: new Date() },
      update: { events: events as unknown as object, fetchedAt: new Date() },
    });
    lastFailureAt = 0;
    // web4 (issues.md 151): keep this week's high-impact events for good (the news-trading flag's history). web6: after
    // the response (it never holds the trader's request), best-effort; the 6-hourly cron records them as well.
    await runAfterResponse("economic-events", () =>
      recordHighImpactEvents(prisma, events).catch((e) => console.warn("[economic-calendar] recording event history failed", e instanceof Error ? e.message : e))
    );
    return { events, source: "forexfactory" };
  } catch (err) {
    lastFailureAt = Date.now();
    console.warn("[economic-calendar] ForexFactory fetch failed", err instanceof Error ? err.message : err);
    if (cachedEvents) {
      return { events: cachedEvents, source: "forexfactory-stale" };
    }
    throw err;
  }
}
