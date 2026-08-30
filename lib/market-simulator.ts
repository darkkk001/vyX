// Client-side price simulation — same approach as the vyx-webtrader.html
// prototype and the Phase 2 plan ("keep price simulation client-side for
// now, do not build the real execution engine yet"). Phase 5 replaces this
// with a real tick feed; the shape (symbol -> {bid, ask, candles}) is
// deliberately the only thing components depend on, so swapping the
// source later doesn't touch the UI.

export type SymbolCategory = "FOREX" | "METALS" | "CRYPTO" | "INDICES";

export type SymbolDef = {
  name: string;
  category: SymbolCategory;
  digits: number;
  base: number;
  vol: number;
  contractSize: number;
};

export const SYMBOL_DEFS: SymbolDef[] = [
  { name: "XAUUSD", category: "METALS", digits: 2, base: 2352.40, vol: 0.35, contractSize: 100 },
  { name: "EURUSD", category: "FOREX", digits: 5, base: 1.0850, vol: 0.00006, contractSize: 100000 },
  { name: "GBPUSD", category: "FOREX", digits: 5, base: 1.2680, vol: 0.00007, contractSize: 100000 },
  { name: "BTCUSD", category: "CRYPTO", digits: 1, base: 62150.0, vol: 25, contractSize: 1 },
  { name: "US30", category: "INDICES", digits: 1, base: 38950.0, vol: 4.5, contractSize: 1 },
  { name: "USDJPY", category: "FOREX", digits: 3, base: 156.20, vol: 0.008, contractSize: 100000 },
  { name: "AUDUSD", category: "FOREX", digits: 5, base: 0.6520, vol: 0.00005, contractSize: 100000 },
  { name: "XAGUSD", category: "METALS", digits: 3, base: 27.80, vol: 0.02, contractSize: 5000 },
  { name: "ETHUSD", category: "CRYPTO", digits: 2, base: 3420.00, vol: 3.2, contractSize: 1 },
  { name: "NAS100", category: "INDICES", digits: 1, base: 18240.0, vol: 5.5, contractSize: 1 },
];

export type Timeframe = "M1" | "M5" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1" | "Y1";
export const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"];

export type Candle = { o: number; h: number; l: number; c: number; t: number };

export type MarketState = {
  def: SymbolDef;
  bid: number;
  ask: number;
  prevBid: number;
  dayOpen: number;
  high: number;
  low: number;
  candles: Record<Timeframe, Candle[]>;
  // Unix ms of the current open bucket's start per timeframe — comparing
  // against a fresh bucketStartMs() each tick is what decides "still the
  // same bar" vs "start a new one".
  lastCandleStart: Record<Timeframe, number>;
  // True only while the most recent real tick for this symbol (via the
  // MT5 EA bridge / gateway WebSocket) is within LIVE_MAX_AGE_MS of "now"
  // -- see tickMarket(). No symbol ever fakes movement while this is
  // false. Before fix/realtime-sync §2, this never expired once true (a
  // symbol's entry in liveTicksRef is sticky/accumulating and nothing
  // ever re-checked its age), so a feed that silently died left the UI
  // showing a frozen price as if it were still live, indefinitely.
  live: boolean;
  // Epoch ms of the last real tick ever applied to this symbol this
  // session, 0 if none yet. Distinct from `live` (a same-session/serverNow
  // clock reference `feedStatusFor` needs to distinguish "just went
  // stale" from "long dead" and "never connected" -- `live` alone
  // collapses all of those to the same false).
  lastTickAt: number;
};

// Matches the "no-feed after 30s" threshold in feedStatusFor below --
// this is the point past which a symbol's last known price is old enough
// that showing it as live would be presenting a fabricated-looking price
// as real (see this file's own long-standing rule on that).
const LIVE_MAX_AGE_MS = 30_000;

export type FeedStatus = "connecting" | "live" | "stale" | "no-feed";

// fix/realtime-sync §2's 4-state UI model, replacing the old binary
// live/dead the chart used to render straight off `MarketState.live`.
// `sessionStartedAt` bounds "connecting" to a real window (otherwise a
// symbol that never gets a tick would spin forever) and is what makes
// "never show an error in the first 5s" possible: a fresh mount with zero
// ticks yet reads as "connecting", not "no-feed", for up to 30s.
export function feedStatusFor(lastTickAt: number, now: number, sessionStartedAt: number): FeedStatus {
  if (lastTickAt) {
    const age = now - lastTickAt;
    if (age <= 5000) return "live";
    if (age <= LIVE_MAX_AGE_MS) return "stale";
    return "no-feed";
  }
  return now - sessionStartedAt <= LIVE_MAX_AGE_MS ? "connecting" : "no-feed";
}

export function spreadFor(def: SymbolDef): number {
  return def.digits >= 3 ? def.vol * 0.6 : def.base * 0.00006;
}

// M1..D1 are fixed-duration and bucket cleanly by floor-division. W1/MN1/Y1
// aren't — weeks don't align to the epoch at a Monday boundary, and
// months/years vary in length — so those need real calendar math instead
// of a fixed millisecond divisor. Mirrors lib/price-feed.ts's server-side
// bucketing exactly, so client-simulated and server-fed candles for the
// same timeframe always land on the same bucket boundaries.
const FIXED_MS: Partial<Record<Timeframe, number>> = {
  M1: 60_000,
  M5: 300_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

// Approximate spacing, only used for spacing the synthetic seed history —
// calendar timeframes don't have a true fixed length, this just needs to
// be "roughly right" for that.
export function tfMillis(tf: Timeframe): number {
  if (FIXED_MS[tf]) return FIXED_MS[tf]!;
  if (tf === "W1") return 7 * 86_400_000;
  if (tf === "MN1") return 30 * 86_400_000;
  return 365 * 86_400_000; // Y1
}

// Exported for WebTrader.tsx's seedRealCandles (fix/realtime-sync §3) --
// after loading real history on a timeframe switch, it needs to know
// whether the server's last row IS the currently-open bucket (in which
// case the live tick that's already arrived since that row was written
// should immediately overwrite it) or a fully-closed historical one
// (nothing to reconcile).
export function bucketStartMs(tf: Timeframe, now: number): number {
  const fixed = FIXED_MS[tf];
  if (fixed) return Math.floor(now / fixed) * fixed;

  const d = new Date(now);
  if (tf === "W1") {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
  }
  if (tf === "MN1") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), 0, 1); // Y1
}

export function createInitialMarket(): Record<string, MarketState> {
  const market: Record<string, MarketState> = {};
  for (const def of SYMBOL_DEFS) {
    const spread = spreadFor(def);
    market[def.name] = {
      def,
      // Placeholder only — never rendered while `live` is false (see
      // ChartCell/WebTrader's "No live feed" state). Exists so order-ticket
      // math has a number to read before any real tick arrives.
      bid: def.base,
      ask: def.base + spread,
      prevBid: def.base,
      dayOpen: def.base,
      high: def.base,
      low: def.base,
      candles: TIMEFRAMES.reduce((acc, tf) => { acc[tf] = []; return acc; }, {} as Record<Timeframe, Candle[]>),
      lastCandleStart: TIMEFRAMES.reduce((acc, tf) => { acc[tf] = 0; return acc; }, {} as Record<Timeframe, number>),
      live: false,
      lastTickAt: 0,
    };
  }
  return market;
}

function applyBidAsk(m: MarketState, bid: number, ask: number, now: number) {
  m.prevBid = m.bid;
  m.bid = bid;
  m.ask = ask;
  m.high = Math.max(m.high, m.bid);
  m.low = Math.min(m.low, m.bid);

  TIMEFRAMES.forEach((tf) => {
    const start = bucketStartMs(tf, now);
    const candles = m.candles[tf];
    if (m.lastCandleStart[tf] !== start) {
      m.lastCandleStart[tf] = start;
      candles.push({ o: m.bid, h: m.bid, l: m.bid, c: m.bid, t: start });
      if (candles.length > 300) candles.shift(); // matches the chart's max zoom-out (chartZoom cap)
    } else if (candles.length) {
      // Replaces the last element with a new object instead of mutating
      // its fields in place (fix/realtime-sync §3) -- KLineChartPanel's
      // incremental-update effect depends on this exact object's
      // reference to know a new tick landed; an in-place mutation left
      // that reference unchanged forever, so the chart's own last candle
      // never moved on a live tick at all, only on a full history reload
      // (a timeframe switch) that happened to pick up whatever the
      // (correctly up-to-date underneath) data already was -- see
      // KLineChartPanel.tsx's own comment on `latestBar`.
      const c = candles[candles.length - 1];
      candles[candles.length - 1] = { o: c.o, h: Math.max(c.h, m.bid), l: Math.min(c.l, m.bid), c: m.bid, t: c.t };
    }
  });
}

// Mutates and returns a new top-level object (shallow clone) so React
// re-renders on tick, while each MarketState is mutated in place for
// perf (candle arrays would be expensive to deep-clone every second).
//
// liveTicks (optional): real bid/ask pulled from a broker's own MT5
// terminal via the price-feed bridge (see app/api/internal/price-feed).
// A symbol with no entry here is never faked — it's marked `live: false`
// and its bid/ask/candles stay frozen at their last real values until a
// real tick shows up for it again. A trading platform must never present
// a fabricated price as if it were real, or let anything (auto-close,
// order placement) act on one — see ChartCell/WebTrader's "No live feed"
// state and app/api/trade/orders/route.ts's server-side freshness check.
//
// `now` (optional, defaults to the trader's own Date.now()): the moment
// used to decide which candle bucket this tick belongs to. Callers with
// real ticks should pass a server-clock-corrected value (lib/trade-
// api.ts's serverNow()) instead of the default -- the trader's own
// system clock can be skewed by minutes, and bucketing a live candle
// against the wrong clock misaligns it against the real, server-seeded
// history the instant the two meet on the chart. Reported live as
// candles looking "torn."
export function tickMarket(
  market: Record<string, MarketState>,
  liveTicks?: Record<string, { bid: number; ask: number; at: number }>,
  now: number = Date.now()
): Record<string, MarketState> {
  for (const [name, m] of Object.entries(market)) {
    const tick = liveTicks?.[name];
    if (tick && now - tick.at <= LIVE_MAX_AGE_MS) {
      // Only re-applies bid/ask when this is actually a fresher tick than
      // what's already reflected -- otherwise a stale-but-not-yet-expired
      // entry would keep re-pushing the same identical candle update
      // every 1.5s tickMarket cycle, same wasted-write concern
      // engine/market-data's own dirty-tracking fix addressed server-side.
      if (tick.at !== m.lastTickAt) {
        applyBidAsk(m, tick.bid, tick.ask, now);
        m.lastTickAt = tick.at;
      }
      m.live = true;
    } else {
      m.live = false;
    }
  }
  return { ...market };
}

export function fmt(value: number, digits: number): string {
  return value.toFixed(digits);
}

export function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return sign + "$" + Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
