// QoreTrader demo prices: ONE pure module, imported by the server (order, close, modify, pending trigger, the lazy SL/TP
// sweep) and by the browser (the quote ticker and the chart). No randomness at run time, no I/O, no Date.now(): the same
// (symbol, timestamp) always gives the same bid/ask on both sides, so the server's price for an order is exactly the price the
// trader's screen showed at that moment.
//
// The path of one symbol is  mid(t) = base * (1 + rel(t)), with rel(t) a sum of
//   - nine octaves of hashed "value noise" (a seeded lattice, smootherstep between lattice points), periods 1.5 s ... 27 h,
//     amplitude growing with the square root of the period (a random-walk look: calm over a second, wandering over a day),
//   - three slow sines (3.1, 8.7 and 21 days) that keep the level wandering around the base for weeks.
// Every term is bounded, so the price stays inside base * (1 +- maxDev) forever, and its speed is bounded too (slopeBound),
// which is what lets the lazy SL/TP sweep (lib/demo-sweep.ts) jump over long stretches without missing a touch.
//
// Cross-engine determinism: only + - * / and Math.floor / Math.round / Math.imul are used (all exact in IEEE 754 and in every
// JS engine). Math.sin is deliberately NOT used (its last bit differs between engines); sinTurns below is a plain polynomial.
//
// Units: prices are computed in integer POINTS (10^-digits) so a bid/ask pair is exact: ask = bid + spreadPts, always.

export const DEMO_PREFIX = "q";
/** The quote grid: a tick is one 250 ms step. The browser ticks on it; the sweep treats a touch as seen on it. */
export const DEMO_GRID_MS = 250;
/** A client quote older than this (or from the future by more than DEMO_FUTURE_SLACK_MS) is refused: "Price changed". */
export const DEMO_MAX_QUOTE_AGE_MS = 3000;
export const DEMO_FUTURE_SLACK_MS = 1500;

export type DemoCategory = "FOREX" | "METALS" | "CRYPTO" | "INDICES";

export type DemoSymbolDef = {
  /** the internal name in the API and the database ("qXAUUSD") */
  name: string;
  /** what the trader sees ("XAUUSD") */
  display: string;
  category: DemoCategory;
  baseCurrency: string;
  /** the Symbol.quoteCurrency of the demo row. USDJPY is "QJP" (not JPY): see conversionAliasFor. */
  quoteCurrency: string;
  digits: number;
  contractSize: number;
  base: number;
  /** constant spread, in points */
  spreadPts: number;
  /** typical daily move as a fraction of the price (1 sigma) */
  dailyVol: number;
  seed: number;
};

// Levels, digits, contract sizes and spreads of the real symbols (digits / contract sizes are the ones the platform's real
// Symbol rows carry; scripts/seed-qoredemo.ts refuses to run if a real row disagrees).
export const DEMO_SYMBOLS: readonly DemoSymbolDef[] = [
  { name: "qXAUUSD", display: "XAUUSD", category: "METALS", baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: 100, base: 4450, spreadPts: 30, dailyVol: 0.010, seed: 1101 },
  { name: "qEURUSD", display: "EURUSD", category: "FOREX", baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: 100000, base: 1.158, spreadPts: 12, dailyVol: 0.0045, seed: 2202 },
  { name: "qGBPUSD", display: "GBPUSD", category: "FOREX", baseCurrency: "GBP", quoteCurrency: "USD", digits: 5, contractSize: 100000, base: 1.314, spreadPts: 15, dailyVol: 0.005, seed: 3303 },
  { name: "qUSDJPY", display: "USDJPY", category: "FOREX", baseCurrency: "USD", quoteCurrency: "QJP", digits: 3, contractSize: 100000, base: 152.3, spreadPts: 15, dailyVol: 0.0055, seed: 4404 },
  { name: "qBTCUSD", display: "BTCUSD", category: "CRYPTO", baseCurrency: "BTC", quoteCurrency: "USD", digits: 1, contractSize: 1, base: 77000, spreadPts: 250, dailyVol: 0.022, seed: 5505 },
  { name: "qUS30", display: "US30", category: "INDICES", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: 1, base: 44200, spreadPts: 20, dailyVol: 0.008, seed: 6606 },
  { name: "qNAS100", display: "NAS100", category: "INDICES", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: 1, base: 20400, spreadPts: 15, dailyVol: 0.012, seed: 7707 },
];

const BY_NAME = new Map(DEMO_SYMBOLS.map((d) => [d.name, d]));
const BY_DISPLAY = new Map(DEMO_SYMBOLS.map((d) => [d.display, d]));

export function isDemoSymbolName(name: string | null | undefined): boolean {
  return typeof name === "string" && BY_NAME.has(name);
}
/** Any name the demo reserves: the prefix "q" followed by an upper-case/digit name (a future demo symbol too). Used by the isolation rules. */
export function isReservedDemoName(name: string | null | undefined): boolean {
  return typeof name === "string" && /^q[A-Z0-9]+$/.test(name);
}
export function demoDef(name: string): DemoSymbolDef | undefined {
  return BY_NAME.get(name);
}
export function demoDefByDisplay(display: string): DemoSymbolDef | undefined {
  return BY_DISPLAY.get(display);
}
/** "qXAUUSD" -> "XAUUSD" (display only); anything else unchanged. */
export function demoDisplayName(name: string): string {
  return BY_NAME.get(name)?.display ?? name;
}

/**
 * The demo's quote-currency conversion pair: a position in qUSDJPY has quote currency "QJP", so the platform's FX lookup asks
 * for "USDQJP" / "QJPUSD". No real symbol can ever have that name, so this alias is served by the demo only and a real
 * broker's FX conversion is never touched. Returns the demo symbol whose quote answers the name, or null.
 */
export function demoSymbolForPriceName(name: string): DemoSymbolDef | null {
  const d = BY_NAME.get(name);
  if (d) return d;
  if (name === "USDQJP") return BY_NAME.get("qUSDJPY") ?? null;
  return null;
}

// ---- deterministic building blocks (integer math + IEEE basic operations only) ----

function hash32(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
/** lattice value in [-1, 1) */
function lattice(seed: number, octave: number, i: number): number {
  return hash32(seed + octave * 7919, i >>> 0) / 2147483648 - 1;
}
function smootherstep(u: number): number {
  return u * u * u * (u * (u * 6 - 15) + 10);
}
function noise(seed: number, octave: number, periodSec: number, tSec: number): number {
  const x = tSec / periodSec;
  const i = Math.floor(x);
  const u = x - i;
  const a = lattice(seed, octave, i);
  const b = lattice(seed, octave, i + 1);
  return a + (b - a) * smootherstep(u);
}
/** sin(2*pi*x), x in turns: range-reduced, then a Taylor polynomial on [-pi/2, pi/2] (error < 1e-11). */
function sinTurns(x: number): number {
  let r = x - Math.floor(x); // [0, 1)
  if (r >= 0.5) r -= 1; // [-0.5, 0.5)
  if (r > 0.25) r = 0.5 - r;
  else if (r < -0.25) r = -0.5 - r;
  const th = r * 6.283185307179586;
  const t2 = th * th;
  // th * (1 - t2/6 + t2^2/120 - ... up to th^17)
  return th * (1 + t2 * (-1 / 6 + t2 * (1 / 120 + t2 * (-1 / 5040 + t2 * (1 / 362880 + t2 * (-1 / 39916800 + t2 * (1 / 6227020800 + t2 * (-1 / 1307674368000 + t2 * (1 / 355687428096000)))))))));
}

const OCTAVE_PERIODS_SEC = [1.5, 6, 24, 96, 384, 1536, 6144, 24576, 98304];
const SINE_PERIODS_SEC = [3.1 * 86400, 8.7 * 86400, 21 * 86400];
/** value-noise amplitude per sqrt(second) as a multiple of dailyVol / sqrt(86400); tuned so a 1 h move is about dailyVol * sqrt(1/24) */
const NOISE_GAIN = 1.0;
const SINE_GAINS = [0.35, 0.8, 1.4]; // x dailyVol
/** longest octaves stop growing with the square root of the period: no octave is wider than this multiple of dailyVol */
const OCTAVE_CAP = 0.55;

type Shape = { octaveAmp: number[]; sineAmp: number[]; maxDev: number; slopePerSec: number };
const SHAPES = new Map<string, Shape>();
function shapeOf(d: DemoSymbolDef): Shape {
  let s = SHAPES.get(d.name);
  if (s) return s;
  const perRoot = d.dailyVol / Math.sqrt(86400);
  const octaveAmp = OCTAVE_PERIODS_SEC.map((p) => Math.min(NOISE_GAIN * perRoot * Math.sqrt(p), OCTAVE_CAP * d.dailyVol));
  const sineAmp = SINE_GAINS.map((g) => g * d.dailyVol);
  const maxDev = octaveAmp.reduce((a, b) => a + b, 0) + sineAmp.reduce((a, b) => a + b, 0);
  const slopePerSec =
    octaveAmp.reduce((a, A, k) => a + (A * 3.75) / OCTAVE_PERIODS_SEC[k], 0) + sineAmp.reduce((a, B, k) => a + (B * 6.283185307179586) / SINE_PERIODS_SEC[k], 0);
  s = { octaveAmp, sineAmp, maxDev, slopePerSec };
  SHAPES.set(d.name, s);
  return s;
}

/** relative deviation from the base level at time tMs */
function rel(d: DemoSymbolDef, tMs: number): number {
  const sh = shapeOf(d);
  const tSec = tMs / 1000;
  let sum = 0;
  for (let k = 0; k < OCTAVE_PERIODS_SEC.length; k++) sum += sh.octaveAmp[k] * noise(d.seed, k, OCTAVE_PERIODS_SEC[k], tSec);
  for (let k = 0; k < SINE_PERIODS_SEC.length; k++) sum += sh.sineAmp[k] * sinTurns(tSec / SINE_PERIODS_SEC[k] + (d.seed % 97) / 97 + k / 3);
  return sum;
}

function pow10(n: number): number {
  let r = 1;
  for (let i = 0; i < n; i++) r *= 10;
  return r;
}

/** The mid price in points (an integer). */
function midPts(d: DemoSymbolDef, tMs: number): number {
  return Math.round(d.base * (1 + rel(d, tMs)) * pow10(d.digits));
}

/** points -> a decimal string with exactly `digits` decimals ("4450.12") */
export function ptsToString(pts: number, digits: number): string {
  const neg = pts < 0;
  let s = String(Math.abs(pts));
  if (digits > 0) {
    while (s.length <= digits) s = "0" + s;
    s = s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
  }
  return neg ? "-" + s : s;
}

export type DemoQuote = { symbol: string; bid: string; ask: string; bidPts: number; askPts: number; digits: number; at: number };

/** Bid/ask of a demo symbol at time tMs (any integer ms). Same inputs, same output, everywhere. */
export function demoQuoteAt(name: string, tMs: number): DemoQuote | null {
  const d = BY_NAME.get(name);
  if (!d) return null;
  const mid = midPts(d, Math.floor(tMs));
  const bidPts = mid - Math.floor(d.spreadPts / 2);
  const askPts = bidPts + d.spreadPts;
  return { symbol: d.name, bid: ptsToString(bidPts, d.digits), ask: ptsToString(askPts, d.digits), bidPts, askPts, digits: d.digits, at: Math.floor(tMs) };
}

/** The tick time the browser shows for a given clock reading: the start of its 250 ms step. */
export function gridTime(tMs: number): number {
  return Math.floor(tMs / DEMO_GRID_MS) * DEMO_GRID_MS;
}

/**
 * Largest possible price move per second (price units) of a symbol, plus the rounding to a point: with this, a price that is
 * `gap` away from a level cannot reach it sooner than gap / slope seconds. The sweep uses it to skip ahead safely.
 */
export function demoSlopePerSec(name: string): number {
  const d = BY_NAME.get(name);
  if (!d) return 0;
  return d.base * shapeOf(d).slopePerSec;
}
/** The widest the price can ever stray from its base (fraction). */
export function demoMaxDeviation(name: string): number {
  const d = BY_NAME.get(name);
  return d ? shapeOf(d).maxDev : 0;
}
export function demoPointSize(name: string): number {
  const d = BY_NAME.get(name);
  return d ? 1 / pow10(d.digits) : 0;
}

// ---- candles ----

export type DemoTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1" | "Y1";
const FIXED_TF_MS: Record<string, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000, W1: 604_800_000 };
/** the same alignment lib/market-simulator.ts bucketStartMs uses (UTC; W1 starts Monday) */
export function demoBucketStart(tf: DemoTimeframe, tMs: number): number {
  if (tf === "W1") {
    const d = new Date(tMs);
    const sinceMonday = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  }
  const fixed = FIXED_TF_MS[tf];
  if (fixed) return Math.floor(tMs / fixed) * fixed;
  const d = new Date(tMs);
  if (tf === "MN1") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), 0, 1); // Y1
}
function previousBucketStart(tf: DemoTimeframe, start: number): number {
  const fixed = FIXED_TF_MS[tf];
  if (fixed) return start - fixed;
  const d = new Date(start);
  if (tf === "MN1") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  return Date.UTC(d.getUTCFullYear() - 1, 0, 1);
}
function nextBucketStart(tf: DemoTimeframe, start: number): number {
  const fixed = FIXED_TF_MS[tf];
  if (fixed) return start + fixed;
  const d = new Date(start);
  if (tf === "MN1") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
}

export const DEMO_SAMPLES_PER_CANDLE = 240;

export type DemoCandle = { bucketStart: number; open: string; high: string; low: string; close: string };

/**
 * OHLC of ONE bucket on the BID, sampled on the 250 ms tick grid: every sample is a tick the browser would have shown.
 * Up to M1 every tick is used (the candle is exact); a longer bucket takes a evenly spread subset of at most 240 ticks.
 * `untilMs` ends the forming bucket at the last tick not after it. Returns null when no tick falls in the bucket yet.
 */
export function demoCandleOf(name: string, tf: DemoTimeframe, bucketStart: number, untilMs: number): DemoCandle | null {
  const d = BY_NAME.get(name);
  if (!d) return null;
  const end = Math.min(nextBucketStart(tf, bucketStart), gridTime(untilMs) + DEMO_GRID_MS); // exclusive
  const first = Math.ceil(bucketStart / DEMO_GRID_MS) * DEMO_GRID_MS;
  if (first >= end) return null;
  const ticks = Math.floor((end - 1 - first) / DEMO_GRID_MS) + 1;
  const stride = Math.max(1, Math.ceil(ticks / DEMO_SAMPLES_PER_CANDLE));
  const half = Math.floor(d.spreadPts / 2);
  let open = 0;
  let close = 0;
  let high = -Infinity;
  let low = Infinity;
  let last = first;
  for (let k = 0; k < ticks; k += stride) {
    const t = first + k * DEMO_GRID_MS;
    const bid = midPts(d, t) - half;
    if (k === 0) open = bid;
    close = bid;
    last = t;
    if (bid > high) high = bid;
    if (bid < low) low = bid;
  }
  // the final tick of the bucket always counts as the close (it may fall between strides)
  const lastTick = first + (ticks - 1) * DEMO_GRID_MS;
  if (lastTick !== last) {
    const bid = midPts(d, lastTick) - half;
    close = bid;
    if (bid > high) high = bid;
    if (bid < low) low = bid;
  }
  return { bucketStart, open: ptsToString(open, d.digits), high: ptsToString(high, d.digits), low: ptsToString(low, d.digits), close: ptsToString(close, d.digits) };
}

/** The newest `count` candles ending with the one forming at `nowMs`, oldest first. */
export function demoCandles(name: string, tf: DemoTimeframe, nowMs: number, count = 300): DemoCandle[] {
  if (!BY_NAME.has(name)) return [];
  const out: DemoCandle[] = [];
  let start = demoBucketStart(tf, nowMs);
  for (let i = 0; i < count; i++) {
    const c = demoCandleOf(name, tf, start, nowMs);
    if (c) out.push(c);
    start = previousBucketStart(tf, start);
  }
  return out.reverse();
}

/**
 * The age rule for a client's quote (a market order, a close, a modify): the request names the time of the quote it was
 * made from (priceAt, ms). Missing, older than DEMO_MAX_QUOTE_AGE_MS, or from the future beyond the clock slack = "Price
 * changed, try again". The server never fills at the client's price: it recomputes at its own clock; this only refuses a
 * request made on a stale screen.
 */
export function demoQuoteTimeRefusal(priceAt: unknown, nowMs: number): "PRICE_CHANGED" | null {
  const t = typeof priceAt === "number" ? priceAt : typeof priceAt === "string" && priceAt.trim() !== "" ? Number(priceAt) : NaN;
  if (!Number.isFinite(t)) return "PRICE_CHANGED";
  if (nowMs - t > DEMO_MAX_QUOTE_AGE_MS) return "PRICE_CHANGED";
  if (t - nowMs > DEMO_FUTURE_SLACK_MS) return "PRICE_CHANGED";
  return null;
}
