// PRIORITY 3: the shared tick store.
//
// WHY THIS EXISTS. Until now the trading engine was the only thing that knew a price: the MT5 EA
// posted ticks to its `/internal/price-feed`, the engine held them in memory, and the web read them
// back from its `/internal/prices`. That made the engine a single point of failure for PRICING as well
// as for execution, and the failover work proved it the hard way -- with the engine killed, the web
// was correctly handed the order and then refused it:
//
//   [price-source] live price read FAILED: refusing to act on a price (no Neon fallback)
//   -> HTTP 400 INVALID_PRICE
//
// So "engine down -> the web fills it" could not be true, however good the routing was. The price had
// to stop living inside the thing that dies.
//
// WHAT IS NOT CHANGED, and this is the part worth being careful about. The refusal above is CORRECT
// and stays: a failed read is never answered from Neon's `LivePrice`, which has been frozen since
// 2026-09-14 (owner decision 2026-09-26). This does not add a fallback to a stale row. It adds a
// SECOND LIVE SOURCE that happens not to be the engine -- and if that source is stale too, the answer
// is still a refusal. A price nobody is currently standing behind must never be quoted.

import { Redis } from "ioredis";

export type Tick = {
  symbol: string;
  bid: string;
  ask: string;
  /** Origin timestamp, ms since epoch, set by the producer. Optional: not every producer sets it. */
  t0?: number;
};

/** Exactly the shape the engine's `/internal/prices` emits, because lib/market-data-client.ts parses it. */
export type StoredPrice = {
  symbol: string;
  bid: string;
  ask: string;
  tickAt: string;
  updatedAt: string;
  ageMs: number;
};

const KEY_PREFIX = "vyx:price:";

/**
 * How long a stored tick may be served at all.
 *
 * NOT the fill-freshness rule -- that is the web's, `FILL_PRICE_MAX_AGE_MS = 3000` in lib/risk.ts, and
 * it stays the authority on whether a price may be traded on. This is the much looser bound on whether
 * a tick is worth returning instead of a 404, so that a symbol whose feed stopped an hour ago reads as
 * ABSENT rather than as a very old price. Both checks matter and they are not the same check: the web
 * refuses a 4-second-old tick for a fill, while a chart or a watchlist is happy with it.
 */
export const MAX_SERVE_AGE_MS = Number(process.env.PRICE_STORE_MAX_SERVE_AGE_MS ?? 60_000);

/** Redis TTL on each key: generous, because expiry is a tidy-up, not the staleness rule. */
const TTL_SECONDS = Math.max(60, Math.ceil(MAX_SERVE_AGE_MS / 1000) * 4);

export class PriceStore {
  constructor(private readonly redis: Redis) {}

  /**
   * Write one tick.
   *
   * `tickAt` is the PRODUCER's own timestamp when it supplied one, and only falls back to ours. That
   * distinction is the whole value of the field: a feed that has gone quiet must look old even though
   * this process wrote the row a moment ago, otherwise a dead feed reads as a fresh price.
   */
  async put(tick: Tick, now = Date.now()): Promise<void> {
    const tickAtMs = typeof tick.t0 === "number" && Number.isFinite(tick.t0) && tick.t0 > 0 ? tick.t0 : now;
    const row = {
      symbol: tick.symbol,
      bid: tick.bid,
      ask: tick.ask,
      tickAt: new Date(tickAtMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    await this.redis.set(KEY_PREFIX + tick.symbol, JSON.stringify(row), "EX", TTL_SECONDS);
  }

  async putMany(ticks: Tick[], now = Date.now()): Promise<number> {
    if (ticks.length === 0) return 0;
    const pipe = this.redis.pipeline();
    for (const t of ticks) {
      const tickAtMs = typeof t.t0 === "number" && Number.isFinite(t.t0) && t.t0 > 0 ? t.t0 : now;
      pipe.set(
        KEY_PREFIX + t.symbol,
        JSON.stringify({
          symbol: t.symbol,
          bid: t.bid,
          ask: t.ask,
          tickAt: new Date(tickAtMs).toISOString(),
          updatedAt: new Date(now).toISOString(),
        }),
        "EX",
        TTL_SECONDS
      );
    }
    await pipe.exec();
    return ticks.length;
  }

  /** One symbol, or null when there is nothing worth serving. `ageMs` is measured off `tickAt`. */
  async get(symbol: string, now = Date.now()): Promise<StoredPrice | null> {
    const raw = await this.redis.get(KEY_PREFIX + symbol);
    return raw ? decode(raw, now) : null;
  }

  /** Every symbol currently held. Scanned rather than KEYS, so a large store does not block Redis. */
  async all(now = Date.now()): Promise<StoredPrice[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", KEY_PREFIX + "*", "COUNT", 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return [];

    const raws = await this.redis.mget(keys);
    const out: StoredPrice[] = [];
    for (const raw of raws) {
      const row = raw ? decode(raw, now) : null;
      if (row) out.push(row);
    }
    return out;
  }
}

/**
 * Parse a stored row, and refuse anything that is not a usable price.
 *
 * A malformed row is dropped rather than repaired. The store is written by one process and read by
 * another, so a shape that does not parse means the two disagree about the format -- and guessing at a
 * price in that situation is exactly the wrong instinct.
 */
function decode(raw: string, now: number): StoredPrice | null {
  try {
    const row = JSON.parse(raw) as Partial<StoredPrice>;
    if (typeof row.symbol !== "string" || typeof row.bid !== "string" || typeof row.ask !== "string") return null;
    if (typeof row.tickAt !== "string" || typeof row.updatedAt !== "string") return null;
    const tickAtMs = Date.parse(row.tickAt);
    if (Number.isNaN(tickAtMs)) return null;
    const ageMs = now - tickAtMs;
    if (ageMs > MAX_SERVE_AGE_MS) return null; // too old to be a price at all
    return { symbol: row.symbol, bid: row.bid, ask: row.ask, tickAt: row.tickAt, updatedAt: row.updatedAt, ageMs };
  } catch {
    return null;
  }
}
