import "server-only";
import { Prisma, type Candle, type CandleTimeframe } from "@prisma/client";

// Neon -> VPS market-data migration, stage S3/S4 (docs/market-data.md §8):
// the web app's read path for candles (and, in S4, live prices) against
// the engine's own store on the Contabo box instead of Neon's Candle /
// LivePrice tables.
//
// Every function here is fail-soft: any transport error, timeout, non-2xx
// or malformed body returns null and the caller runs the Prisma query it
// always ran -- Neon keeps every row while the engine dual-writes
// (MARKET_DATA_WRITE=both), so a fallback is never a data loss, only a
// slower answer. Nothing here is reachable until the env vars below are
// set, which is what makes this deployable ahead of the switch.
//
// Env (all server-side, never sent to a browser):
//   MARKET_DATA_URL          base URL the engine's /internal/* is served
//                            on -- Caddy on the VPS, e.g.
//                            https://feed.vyxtrader.com (no trailing slash).
//                            Falls back to TRADING_CORE_URL.
//   MARKET_DATA_READ_SECRET  the DEDICATED read-only secret, sent as
//                            X-Market-Data-Secret. NOT INTERNAL_SERVICE_SECRET
//                            -- that one also unlocks the order routes and
//                            stays with the gateway.
//   MARKET_DATA_VPS_SYMBOLS  comma-separated symbols served from the VPS;
//                            "*" = every symbol; unset/empty = none (S3
//                            starts with EURUSD).

// What the engine's GET /internal/candles emits: string decimals (numeric
// columns) and ISO-8601 timestamps -- a JSON wire shape, not Prisma's
// runtime row.
type EngineCandle = {
  symbol: string;
  timeframe: string;
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  updatedAt: string;
};

export type EnginePrice = {
  symbol: string;
  bid: string;
  ask: string;
  tickAt: string;
  updatedAt: string;
  ageMs: number;
};

const TIMEFRAMES = new Set<CandleTimeframe>(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"]);
const TIMEOUT_MS = 2000;

function baseUrl(): string | null {
  const raw = process.env.MARKET_DATA_URL ?? process.env.TRADING_CORE_URL ?? "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function readSecret(): string | null {
  const s = (process.env.MARKET_DATA_READ_SECRET ?? "").trim();
  return s.length > 0 ? s : null;
}

/** Symbols whose candle reads go to the VPS store (MARKET_DATA_VPS_SYMBOLS). */
export function vpsSymbols(): Set<string> | "all" {
  const raw = (process.env.MARKET_DATA_VPS_SYMBOLS ?? "").trim();
  if (raw === "*") return "all";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0)
  );
}

export function isVpsSymbol(symbol: string): boolean {
  const set = vpsSymbols();
  return set === "all" || set.has(symbol.toUpperCase());
}

/** True when the client has a URL and a secret to work with at all. */
export function marketDataConfigured(): boolean {
  return baseUrl() !== null && readSecret() !== null;
}

async function getJson(path: string): Promise<unknown | null> {
  const base = baseUrl();
  const secret = readSecret();
  if (!base || !secret) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "X-Market-Data-Secret": secret },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`market-data-client: ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (err) {
    console.warn(`market-data-client: ${path} failed`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isEngineCandle(x: unknown): x is EngineCandle {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.symbol === "string" &&
    typeof c.timeframe === "string" &&
    typeof c.bucketStart === "string" &&
    typeof c.open === "string" &&
    typeof c.high === "string" &&
    typeof c.low === "string" &&
    typeof c.close === "string" &&
    typeof c.updatedAt === "string"
  );
}

/**
 * Engine wire row -> the exact Prisma `Candle` runtime row
 * `prisma.candle.findMany` returns (Prisma.Decimal for the numeric
 * columns, Date for the timestamptz ones, the timeframe as the enum).
 * Returns null for anything that does not convert cleanly -- a NaN price
 * or an unparsable date must never reach a chart.
 */
export function toPrismaCandle(c: EngineCandle): Candle | null {
  if (!TIMEFRAMES.has(c.timeframe as CandleTimeframe)) return null;
  const bucketStart = new Date(c.bucketStart);
  const updatedAt = new Date(c.updatedAt);
  if (Number.isNaN(bucketStart.getTime()) || Number.isNaN(updatedAt.getTime())) return null;
  const dec = (s: string): Prisma.Decimal | null => {
    try {
      const d = new Prisma.Decimal(s);
      return d.isFinite() ? d : null;
    } catch {
      return null;
    }
  };
  const open = dec(c.open);
  const high = dec(c.high);
  const low = dec(c.low);
  const close = dec(c.close);
  if (!open || !high || !low || !close) return null;
  return {
    symbol: c.symbol,
    timeframe: c.timeframe as CandleTimeframe,
    bucketStart,
    open,
    high,
    low,
    close,
    updatedAt,
  };
}

/**
 * The newest `limit` candles of one symbol/timeframe from the VPS store,
 * oldest first, as Prisma `Candle` rows -- the same rows, order and shape
 * `prisma.candle.findMany({ orderBy: desc, take }).reverse()` produces, so
 * NextResponse.json serialises both branches byte-for-byte the same.
 * null = use Neon.
 */
export async function fetchVpsCandles(symbol: string, timeframe: string, limit = 300): Promise<Candle[] | null> {
  const q = new URLSearchParams({ symbol, tf: timeframe, limit: String(limit) });
  const body = await getJson(`/internal/candles?${q.toString()}`);
  if (body === null) return null;
  if (!Array.isArray(body) || !body.every(isEngineCandle)) {
    console.warn("market-data-client: /internal/candles returned an unexpected body");
    return null;
  }
  const rows: Candle[] = [];
  for (const c of body) {
    const row = toPrismaCandle(c);
    if (!row) {
      console.warn("market-data-client: /internal/candles row did not convert", c);
      return null;
    }
    rows.push(row);
  }
  // an empty answer is suspicious for a symbol the feed serves -- let Neon
  // decide rather than blank a chart because the local store is mid-restore
  return rows.length > 0 ? rows : null;
}

/** One symbol's live tick from the engine's memory (S4). null = use Neon's LivePrice. */
export async function fetchVpsPrice(symbol: string): Promise<EnginePrice | null> {
  const row = (await getJson(`/internal/prices/${encodeURIComponent(symbol)}`)) as EnginePrice | null;
  return row && typeof row.bid === "string" && typeof row.ask === "string" ? row : null;
}

/** Every symbol's live tick (S4, /api/trade/prices). null = use Neon. */
export async function fetchVpsPrices(): Promise<EnginePrice[] | null> {
  const rows = await getJson("/internal/prices");
  return Array.isArray(rows) ? (rows as EnginePrice[]) : null;
}
