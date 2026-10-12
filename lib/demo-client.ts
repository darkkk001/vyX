// QoreTrader demo, browser side: the quotes and the chart are computed here from the SAME function the server uses
// (lib/demo-prices.ts), so the WebTrader makes no price request, opens no price socket and asks the server for no chart
// history. This module also keeps the demo's symbol names straight: the API and the database call them qXAUUSD ...,
// the trader sees XAUUSD ... (the q is stripped for display only, here, at the edge of the browser).
import { calibrateServerClock, serverNow, setApiHook, type ApiHook } from "@/lib/desktop-api";
import { setMarketAlwaysOpen } from "@/lib/market-simulator";
import { DEMO_SYMBOLS, demoCandles, demoDefByDisplay, demoQuoteAt, gridTime, type DemoTimeframe } from "@/lib/demo-prices";

const Q_TOKEN = new RegExp(`\\bq(${DEMO_SYMBOLS.map((d) => d.display).join("|")})\\b`, "g");
const DISPLAY_TO_Q = new Map(DEMO_SYMBOLS.map((d) => [d.display, d.name]));

/** "qXAUUSD" -> "XAUUSD" everywhere inside a string (display only). */
export function stripDemoPrefix(text: string): string {
  return text.replace(Q_TOKEN, "$1");
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = mapStrings(x, f);
    return out;
  }
  return v;
}

// Time of the quote the screen shows right now: the last tick the ticker applied. Orders and closes carry it as priceAt.
let lastTickAt = 0;
export function noteDemoTick(t: number): void {
  lastTickAt = t;
}
export function currentQuoteTime(): number {
  return lastTickAt || gridTime(serverNow());
}

/** One tick of every demo symbol at the given grid time: [display name, bid, ask]. */
export function demoTicksAt(t: number): { symbol: string; bid: number; ask: number; at: number }[] {
  return DEMO_SYMBOLS.map((d) => {
    const q = demoQuoteAt(d.name, t)!;
    return { symbol: d.display, bid: Number(q.bid), ask: Number(q.ask), at: t };
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

function pricesAnswer(path: string) {
  const t = gridTime(serverNow());
  const rows = DEMO_SYMBOLS.map((d) => {
    const q = demoQuoteAt(d.name, t)!;
    return { symbol: d.display, bid: q.bid, ask: q.ask, updatedAt: iso(t), tickAt: iso(t), marketClosed: false, askMarkup: "0" };
  });
  if (!path.includes("fx=1")) return rows;
  const j = demoQuoteAt("qUSDJPY", t)!;
  return { prices: rows, fx: { accountCurrency: "USD", quotes: [{ symbol: "USDJPY", bid: j.bid, ask: j.ask, tickAt: iso(t) }], rates: {} } };
}

function candlesAnswer(path: string) {
  const url = new URL(path, "http://demo.local");
  const display = url.searchParams.get("symbol") ?? "";
  const tf = (url.searchParams.get("tf") ?? "M1") as DemoTimeframe;
  const def = demoDefByDisplay(display);
  if (!def) return [];
  const limit = Math.max(1, Math.min(1500, Number(url.searchParams.get("limit")) || 300));
  return demoCandles(def.name, tf, serverNow(), limit).map((c) => ({ symbol: display, timeframe: tf, bucketStart: iso(c.bucketStart), open: c.open, high: c.high, low: c.low, close: c.close }));
}

// Reads the demo tenant refuses: answered here as "nothing", with no request (the server refuses the routes anyway).
const EMPTY_READS: [RegExp, unknown][] = [
  [/^\/api\/trade\/alerts(\?|$)/, []],
  [/^\/api\/trade\/funds-requests(\?|$)/, []],
  [/^\/api\/trade\/payment-methods(\?|$)/, []],
  [/^\/api\/trade\/linked-accounts(\?|$)/, []],
  [/^\/api\/trade\/sessions(\?|$)/, []],
  [/^\/api\/trade\/kyc(\?|$)/, null],
];

const QUOTE_TIMED = [/^\/api\/trade\/orders$/, /^\/api\/trade\/positions\/[^/]+\/close$/];

const hook: ApiHook = {
  local(path, init) {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return null;
    if (path.startsWith("/api/trade/prices")) return { value: pricesAnswer(path) };
    if (path.startsWith("/api/trade/candles")) return { value: candlesAnswer(path) };
    for (const [re, value] of EMPTY_READS) if (re.test(path)) return { value };
    return null;
  },
  request(path, init) {
    let p = path;
    // ?symbol=XAUUSD  ->  ?symbol=qXAUUSD
    p = p.replace(/([?&]symbol=)([A-Za-z0-9]+)/, (_m, pre: string, name: string) => pre + (DISPLAY_TO_Q.get(name) ?? name));
    if (typeof init?.body !== "string") return { path: p, init };
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return { path: p, init };
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const b = { ...(body as Record<string, unknown>) };
      if (typeof b.symbol === "string") b.symbol = DISPLAY_TO_Q.get(b.symbol) ?? b.symbol;
      if (Array.isArray(b.symbolNames)) b.symbolNames = b.symbolNames.map((n) => (typeof n === "string" ? (DISPLAY_TO_Q.get(n) ?? n) : n));
      // the quote the click came from: a market order and a close are refused when it is older than a few seconds
      const route = p.split("?")[0];
      if ((init.method ?? "GET").toUpperCase() === "POST" && QUOTE_TIMED.some((re) => re.test(route))) b.priceAt = currentQuoteTime();
      return { path: p, init: { ...init, body: JSON.stringify(b) } };
    }
    return { path: p, init };
  },
  response(_path, body) {
    return mapStrings(body, stripDemoPrefix);
  },
};

/** Installs the demo's browser transport (idempotent) and sets the clock from the server's render time. */
export function installDemoClient(serverNowMs: number): void {
  calibrateServerClock(serverNowMs);
  setMarketAlwaysOpen(true);
  setApiHook(hook);
}
