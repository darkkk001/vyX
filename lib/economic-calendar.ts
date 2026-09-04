// Impression Pack #3 -- economic calendar on chart. Reuses the existing
// /api/trade/news route rather than adding a second endpoint; this
// module is purely the symbol<->currency matching and high-impact-soon
// logic, shared by the chart markers and the order-ticket warning chip.
//
// VYX-CALENDAR-FALLBACK-V0 -- that route now serves real data by
// default: the configured Finnhub key never had calendar access on its
// plan tier (confirmed with a direct curl against Finnhub itself,
// independent of this app), so lib/economic-calendar-source.ts's
// ForexFactory adapter is the primary source now, DB-cached for 1h.
// countryMatchesCurrency below still works against it unmodified --
// ForexFactory's `country` field is already a bare currency code
// ("USD", "EUR", ...), and every ISO 4217 code in FIAT_CODES happens to
// start with its own ISO 3166 country-code alias ("usd".includes("us"),
// "eur".includes("eu"), etc.), so the existing substring match keeps
// working by coincidence rather than needing a second alias table.
export type CalendarEvent = {
  time: string;
  country: string;
  event: string;
  impact: string;
  actual: string | number | null;
  estimate: string | number | null;
  previous: string | number | null;
};

const FIAT_CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY"];

// Index/commodity symbols with no currency code in their own name.
const SPECIAL_SYMBOL_CURRENCIES: Record<string, string[]> = {
  US30: ["USD"],
  US500: ["USD"],
  NAS100: ["USD"],
  UK100: ["GBP"],
  GER40: ["EUR"],
  JPN225: ["USD"], // Nikkei is JPY-denominated, but USD-quoted CFDs (this platform's convention) trade on USD-driven sentiment too -- included alongside JPY below.
  SpotBrent: ["USD"],
  SpotCrude: ["USD"],
};

// Which fiat currencies' economic events are relevant to a given traded
// symbol -- a pure name-based heuristic (no currency metadata exists on
// SymbolDef today). A plain 6-letter forex pair splits into base+quote;
// everything else falls back to whatever fiat code the name ends with.
export function currenciesForSymbol(symbol: string): string[] {
  if (/^[A-Z]{6}$/.test(symbol)) {
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    if (FIAT_CODES.includes(base) && FIAT_CODES.includes(quote)) return [base, quote];
  }
  if (symbol in SPECIAL_SYMBOL_CURRENCIES) {
    const extra = symbol === "JPN225" ? ["JPY"] : [];
    return [...SPECIAL_SYMBOL_CURRENCIES[symbol], ...extra];
  }
  const trailing = symbol.slice(-3);
  if (FIAT_CODES.includes(trailing)) return [trailing];
  return ["USD"]; // metals/crypto/anything unrecognized -- USD sentiment is the reasonable default
}

// Finnhub's `country` field is inconsistent across plans/docs (full
// names in some samples, ISO-ish codes in others) -- match liberally
// against every alias we've seen documented, case-insensitively.
const CURRENCY_COUNTRY_ALIASES: Record<string, string[]> = {
  USD: ["us", "usa", "united states"],
  EUR: ["eu", "ez", "euro area", "eurozone", "european union"],
  GBP: ["gb", "uk", "united kingdom", "britain"],
  JPY: ["jp", "japan"],
  AUD: ["au", "australia"],
  NZD: ["nz", "new zealand"],
  CAD: ["ca", "canada"],
  CHF: ["ch", "switzerland"],
  CNY: ["cn", "china"],
};

function countryMatchesCurrency(country: string, currency: string): boolean {
  const c = country.trim().toLowerCase();
  return (CURRENCY_COUNTRY_ALIASES[currency] ?? []).some((alias) => c === alias || c.includes(alias));
}

export function filterEventsForSymbol(events: CalendarEvent[], symbol: string): CalendarEvent[] {
  const currencies = currenciesForSymbol(symbol);
  return events.filter((e) => currencies.some((cur) => countryMatchesCurrency(e.country, cur)));
}

// UTC calendar day match -- consistent with every other "today" boundary
// in this app (session hours, day-open resets), not the browser's local
// timezone.
export function isSameUtcDay(event: CalendarEvent, now: Date): boolean {
  const t = new Date(event.time);
  if (Number.isNaN(t.getTime())) return false;
  return (
    t.getUTCFullYear() === now.getUTCFullYear() &&
    t.getUTCMonth() === now.getUTCMonth() &&
    t.getUTCDate() === now.getUTCDate()
  );
}

// Trader-terminal calendar bug (2026-09-04): the panel showed every event
// ForexFactory's "this week" feed returns, including days already passed
// -- nothing in the pipeline (the route, WebTrader.tsx, or NewsPanel) ever
// dropped a past event. Comparing raw Date instants (UTC under the hood
// either way -- a Date carries no timezone of its own, only display does),
// so this is correct regardless of the browser's local timezone; the bug
// was a missing filter, not a timezone bug (confirmed: every other
// timestamp in this terminal already renders via the same
// toLocaleString/toLocaleDateString browser-local convention NewsPanel
// itself already used).
export function filterUpcomingEvents(events: CalendarEvent[], now: Date): CalendarEvent[] {
  const nowMs = now.getTime();
  return events.filter((e) => {
    const t = new Date(e.time).getTime();
    return !Number.isNaN(t) && t >= nowMs;
  });
}

// The soonest high-impact event for this symbol landing within
// `withinMinutes` from `now`, or null. Never looks backward -- an event
// that already happened is history, not a warning.
export function nextHighImpactEventWithin(events: CalendarEvent[], now: Date, withinMinutes: number): CalendarEvent | null {
  const nowMs = now.getTime();
  const windowMs = withinMinutes * 60_000;
  let soonest: CalendarEvent | null = null;
  let soonestMs = Infinity;
  for (const e of events) {
    if (e.impact?.toLowerCase() !== "high") continue;
    const t = new Date(e.time).getTime();
    if (Number.isNaN(t)) continue;
    const delta = t - nowMs;
    if (delta < 0 || delta > windowMs) continue;
    if (t < soonestMs) {
      soonest = e;
      soonestMs = t;
    }
  }
  return soonest;
}
