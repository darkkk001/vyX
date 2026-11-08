// The status line on the Trader's Room sign-in. ONLINE only when every check reported OK; a failed check says so; no
// recent report (null) shows nothing, so the page never claims a state nobody measured.
//
// What a client depends on, and only that (owner 2026-11-09): the way in (the VPS Caddy check) and the prices they
// actually trade on (the trading core's own feed). The QoreBridge FIX feed is NOT one of them: it runs in shadow and
// posts no prices, so its alerts (stale symbols, dropped quotes) said "SOME SERVICES AFFECTED" to clients over
// something they never see.
import { isSyntheticSymbol } from "@/lib/synthetic-symbols";

export type RoomServiceStatus = "ONLINE" | "AFFECTED" | null;
export type CheckState = "OK" | "FAIL" | "NO_REPORT";

export function roomServiceStatus(states: readonly CheckState[]): RoomServiceStatus {
  if (states.includes("FAIL")) return "AFFECTED";
  return states.length > 0 && states.every((s) => s === "OK") ? "ONLINE" : null;
}

/** A symbol that ticked this recently is a live price. */
export const PRICE_FRESH_MS = 60_000;

/** Friday 17:00 to Sunday 17:00 New York: the FX week is closed, so no tick is not an outage. */
export function isWeekendClose(now: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const day = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return day === "Sat" || (day === "Fri" && hour >= 17) || (day === "Sun" && hour < 17);
}

/** Live prices from the trading core's per-symbol stats: OK when any real symbol ticked in the last minute (crypto
 * quotes all week); FAIL when none did while markets are open; NO_REPORT when there is nothing to judge. */
export function livePriceState(perSymbol: readonly { symbol: string; last_tick_age_ms: number }[] | null | undefined, now: number): CheckState {
  const real = (perSymbol ?? []).filter((s) => !isSyntheticSymbol(s.symbol));
  if (real.length === 0) return "NO_REPORT";
  if (real.some((s) => Number.isFinite(s.last_tick_age_ms) && s.last_tick_age_ms <= PRICE_FRESH_MS)) return "OK";
  return isWeekendClose(now) ? "NO_REPORT" : "FAIL";
}

/** Reads the trading core's feed stats (the same source as the backoffice Feed health). A server error is a FAIL; no
 * answer in 2 s, or a refused secret (our configuration, not an outage), claims nothing. Never throws. */
export async function readLivePrices(now = Date.now()): Promise<CheckState> {
  const base = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
  try {
    const res = await fetch(`${base}/internal/feed-stats`, {
      headers: { "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET ?? "" },
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (res.status >= 500) return "FAIL";
    if (!res.ok) return "NO_REPORT";
    const body = (await res.json()) as { per_symbol?: { symbol: string; last_tick_age_ms: number }[] };
    return livePriceState(body.per_symbol, now);
  } catch {
    return "NO_REPORT";
  }
}
