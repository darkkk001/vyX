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

// Proxies Finnhub's economic calendar (free-tier, requires a
// FINNHUB_API_KEY — sign up at finnhub.io) instead of the trader's browser
// calling it directly, so the API key stays server-side. Also avoids
// scraping ForexFactory/FXStreet's own pages, which their terms of service
// don't allow — swap the fetch below for a different provider if Finnhub's
// free tier doesn't cover this endpoint; nothing else needs to change.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "news feed not configured" }, { status: 503 });
  }

  const from = new Date();
  const to = new Date(from.getTime() + 3 * 86_400_000);
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${fmtDate(from)}&to=${fmtDate(to)}&token=${apiKey}`,
      { next: { revalidate: 300 } }
    );
    if (!res.ok) {
      return NextResponse.json({ error: "news feed unavailable" }, { status: 502 });
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
    }));
    events.sort((a, b) => a.time.localeCompare(b.time));
    return NextResponse.json(events.slice(0, 40));
  } catch {
    return NextResponse.json({ error: "news feed unavailable" }, { status: 502 });
  }
}
