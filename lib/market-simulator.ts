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

export type Candle = { o: number; h: number; l: number; c: number; t: number };

export type MarketState = {
  def: SymbolDef;
  bid: number;
  ask: number;
  prevBid: number;
  dayOpen: number;
  high: number;
  low: number;
  candles: Record<"M1" | "M5" | "H1", Candle[]>;
  lastCandleStart: Record<"M1" | "M5" | "H1", number>;
};

export function spreadFor(def: SymbolDef): number {
  return def.digits >= 3 ? def.vol * 0.6 : def.base * 0.00006;
}

export function createInitialMarket(): Record<string, MarketState> {
  const market: Record<string, MarketState> = {};
  for (const def of SYMBOL_DEFS) {
    const spread = spreadFor(def);
    market[def.name] = {
      def,
      bid: def.base,
      ask: def.base + spread,
      prevBid: def.base,
      dayOpen: def.base,
      high: def.base,
      low: def.base,
      candles: { M1: [], M5: [], H1: [] },
      lastCandleStart: { M1: 0, M5: 0, H1: 0 },
    };
  }
  // Seed some initial candle history so charts aren't empty on load.
  for (let i = 0; i < 80; i++) {
    for (const m of Object.values(market)) {
      const drift = (Math.random() - 0.5) * m.def.vol;
      m.bid = Math.max(m.def.vol, m.bid + drift);
      m.ask = m.bid + spreadFor(m.def);
      m.high = Math.max(m.high, m.bid);
      m.low = Math.min(m.low, m.bid);
      (["M1", "M5", "H1"] as const).forEach((tf) => {
        const candles = m.candles[tf];
        const last = candles[candles.length - 1];
        const every = tf === "M1" ? 1 : tf === "M5" ? 3 : 6;
        if (!last || i % every === 0) {
          candles.push({ o: m.bid, h: m.bid, l: m.bid, c: m.bid, t: i });
        } else {
          last.h = Math.max(last.h, m.bid);
          last.l = Math.min(last.l, m.bid);
          last.c = m.bid;
        }
      });
    }
  }
  return market;
}

export function tfMillis(tf: "M1" | "M5" | "H1") {
  return tf === "M1" ? 60_000 : tf === "M5" ? 300_000 : 3_600_000;
}

function applyBidAsk(m: MarketState, bid: number, ask: number) {
  m.prevBid = m.bid;
  m.bid = bid;
  m.ask = ask;
  m.high = Math.max(m.high, m.bid);
  m.low = Math.min(m.low, m.bid);

  (["M1", "M5", "H1"] as const).forEach((tf) => {
    const period = tfMillis(tf);
    const bucket = Math.floor(Date.now() / period);
    const candles = m.candles[tf];
    if (m.lastCandleStart[tf] !== bucket) {
      m.lastCandleStart[tf] = bucket;
      candles.push({ o: m.bid, h: m.bid, l: m.bid, c: m.bid, t: bucket });
      if (candles.length > 300) candles.shift(); // matches the chart's max zoom-out (chartZoom cap)
    } else if (candles.length) {
      const c = candles[candles.length - 1];
      c.h = Math.max(c.h, m.bid);
      c.l = Math.min(c.l, m.bid);
      c.c = m.bid;
    }
  });
}

// Mutates and returns a new top-level object (shallow clone) so React
// re-renders on tick, while each MarketState is mutated in place for
// perf (candle arrays would be expensive to deep-clone every second).
//
// liveTicks (optional): real bid/ask pulled from a broker's own MT5
// terminal via the price-feed bridge (see app/api/internal/price-feed).
// Symbols present there use the real tick instead of the random walk;
// everything else keeps simulating, so a partial feed (e.g. the EA only
// covers forex majors) degrades gracefully instead of breaking symbols
// it doesn't know about.
export function tickMarket(
  market: Record<string, MarketState>,
  liveTicks?: Record<string, { bid: number; ask: number }>
): Record<string, MarketState> {
  for (const [name, m] of Object.entries(market)) {
    const live = liveTicks?.[name];
    if (live) {
      applyBidAsk(m, live.bid, live.ask);
      continue;
    }
    const drift = (Math.random() - 0.5) * m.def.vol;
    const bid = Math.max(m.def.vol, m.bid + drift);
    applyBidAsk(m, bid, bid + spreadFor(m.def));
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
