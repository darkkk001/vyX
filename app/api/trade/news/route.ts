import { NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";

export type NewsEvent = {
  time: string;
  country: string;
  event: string;
  impact: string;
  actual: string | number | null;
  estimate: string | number | null;
  previous: string | number | null;
};

// Proxies Finnhub's economic calendar instead of the trader's browser
// calling it directly, so the API key stays server-side.
//
// CONFIRMED (2026-09-02): the configured FINNHUB_API_KEY gets a real 403
// "You don't have access to this resource" directly from Finnhub on this
// endpoint -- verified with `curl` straight against
// https://finnhub.io/api/v1/calendar/economic, independent of this app
// entirely. This is a plan-tier limitation (economic calendar isn't
// included), not a missing/expired/malformed key -- rotating the key
// again will not fix it. Swap the fetch below for a different provider
// (or upgrade the Finnhub plan) if this needs to actually return real
// data; nothing else needs to change.
//
// Before 2026-09-02 this route wrapped every upstream failure (403
// included) in a blanket 502 and re-hit Finnhub on every single incoming
// request -- Next's `{next:{revalidate}}` fetch cache only ever
// populates on a *successful* response, so a permanently-failing
// upstream meant literally every trader's every poll (every page load
// plus the 5-min client interval) went straight to Finnhub, all day.
// That's the "tight retry loop spamming the console" -- not a client
// bug, a cache that can only ever cache success. Fixed with an explicit
// module-scope cache that also remembers *failure*, with a longer TTL
// than success (real backoff instead of hammering a known-broken
// upstream), and by passing the real upstream status/message through
// instead of a generic 502 so this is diagnosable from the response
// alone next time.
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 15 * 60_000;

type CacheEntry =
  | { kind: "success"; events: NewsEvent[]; expiresAt: number }
  | { kind: "failure"; status: number; message: string; expiresAt: number };

let cache: CacheEntry | null = null;

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  if (cache && cache.expiresAt > Date.now()) {
    if (cache.kind === "success") return NextResponse.json(cache.events);
    return NextResponse.json({ error: cache.message }, { status: cache.status });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    cache = { kind: "failure", status: 503, message: "news feed not configured", expiresAt: Date.now() + FAILURE_TTL_MS };
    return NextResponse.json({ error: "news feed not configured" }, { status: 503 });
  }

  const from = new Date();
  const to = new Date(from.getTime() + 3 * 86_400_000);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = `Finnhub calendar request failed: ${res.status} ${body.slice(0, 200)}`;
      console.warn("[trade/news]", message);
      cache = { kind: "failure", status: res.status, message, expiresAt: Date.now() + FAILURE_TTL_MS };
      return NextResponse.json({ error: message }, { status: res.status });
    }
    const data = await res.json().catch(() => null);
    const raw = Array.isArray(data?.economicCalendar) ? data.economicCalendar : [];
    const events: NewsEvent[] = raw.map((e: Record<string, unknown>) => ({
      time: String(e.time ?? ""),
      country: String(e.country ?? ""),
      event: String(e.event ?? ""),
      impact: String(e.impact ?? "low"),
      actual: (e.actual as string | number | null) ?? null,
      estimate: (e.estimate as string | number | null) ?? null,
      previous: (e.prev as string | number | null) ?? null,
    })).slice(0, 40);
    events.sort((a, b) => a.time.localeCompare(b.time));
    cache = { kind: "success", events, expiresAt: Date.now() + SUCCESS_TTL_MS };
    return NextResponse.json(events);
  } catch (err) {
    const message = `Finnhub calendar request threw: ${err instanceof Error ? err.message : String(err)}`;
    console.warn("[trade/news]", message);
    cache = { kind: "failure", status: 502, message, expiresAt: Date.now() + FAILURE_TTL_MS };
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
