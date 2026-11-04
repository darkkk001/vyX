// PRIORITY 3: the standalone price feed. The process that closes the price single point of failure.
//
// ── THE SHAPE OF THE PROBLEM
//
// Before this, one process was both the price source and the execution engine:
//
//   MT5 EA  ──>  trading-engine (/internal/price-feed, in-memory TickCache)  ──>  web (/internal/prices)
//                     │
//                     └── also: every fill
//
// Kill the engine and the web loses prices as well as execution, so the failover guard could route an
// order to the web path perfectly and the web would then refuse it for want of a quote. Measured, not
// supposed: `[price-source] live price read FAILED: refusing to act on a price (no Neon fallback)`
// -> HTTP 400 INVALID_PRICE.
//
// ── THE SHAPE OF THE ANSWER
//
//   MT5 EA  ──>  THIS PROCESS  ──>  Redis  ──>  web (/internal/prices)
//                     │
//                     └── fan-out ──>  trading-engine (/internal/price-feed)  ──>  fills
//
// The feed now sits in FRONT of the engine rather than inside it. Two consequences, and the second is
// the point:
//   - the engine still gets every tick, by fan-out, so its fills price exactly as they did before;
//   - when the engine dies, this process does not, so the web keeps reading live prices from Redis and
//     can fill on its own path.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not add a fallback to Neon's `LivePrice`. That row has been frozen since 2026-09-14 and the
// owner's 2026-09-26 decision -- a failed read is answered with a refusal, never with a stale row --
// stands. This is a second LIVE source, not a tolerance for dead prices. If this store is stale too,
// the web refuses, and `GET /internal/prices` returning nothing is how it says so.
//
// It is also not the FIX-feed migration. Same producer, same ticks, same prices; only the topology
// changes.
//
// ── WHY A SEPARATE PROCESS AND NOT THE GATEWAY
//
// The gateway already survives the engine, so it could have hosted this. It should not: it is on the
// order critical path, and a tick ingest running at a few hundred writes a second on the same event
// loop would add jitter to exactly the latency this cutover spent weeks removing. Separate process,
// separate failure, separate CPU.
//
// ── CANDLES ARE PROXIED, NOT SERVED
//
// `lib/market-data-client.ts` reads candles from the same base URL as prices, so this process has to
// answer `/internal/candles` too or repointing the web at it would break every chart. Candles live in
// Postgres and are history: they are proxied straight through to the engine. If the engine is down,
// charts degrade and ORDERS DO NOT -- which is the correct order of priorities and the whole reason
// prices are the thing that got decoupled.

import express from "express";

import { PriceStore, type Tick } from "./store.js";

export type AppDeps = {
  store: PriceStore;
  priceFeedSecret: string;
  marketDataReadSecret: string;
  /** Where ticks are forwarded so the engine's own fills keep pricing as before. Empty = no fan-out. */
  tradingCoreUrl: string;
};

/** Operational counters, exposed so a test can assert the fan-out happened without timing games. */
export type Stats = { ingested: number; fanoutFailures: number; lastIngestAt: number };

export function createApp(deps: AppDeps): { app: express.Express; stats: Stats } {
  const { store, priceFeedSecret, marketDataReadSecret, tradingCoreUrl } = deps;
  const stats: Stats = { ingested: 0, fanoutFailures: 0, lastIngestAt: 0 };

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  /** Length-checked then compared, same convention as the engine's two internal secrets. */
  const authorised = (provided: unknown, expected: string): boolean =>
    typeof provided === "string" && expected.length > 0 && provided.length === expected.length && provided === expected;

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // -- INGEST --------------------------------------------------------------------------------------
  //
  // Same path, same header and same body as the engine's own ingest, so the producer needs no change
  // beyond the host it posts to. A single tick or an array; the EA sends batches.

  app.post("/internal/price-feed", async (req, res) => {
    if (!authorised(req.headers["x-price-feed-secret"], priceFeedSecret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = req.body as Tick | Tick[] | null;
    const all = Array.isArray(body) ? body : body ? [body] : [];
    const ticks = all.filter(
      (t): t is Tick =>
        !!t && typeof t.symbol === "string" && t.symbol.length > 0 && typeof t.bid === "string" && typeof t.ask === "string"
    );
    if (ticks.length === 0) {
      res.status(400).json({ error: "no usable ticks" });
      return;
    }

    // THE STORE FIRST, and awaited. The engine's copy is a convenience -- it can be re-sent on the next
    // tick, a fraction of a second later. The store is what the web reads when the engine is gone, so
    // it is the write that must have happened before this returns 200.
    try {
      await store.putMany(ticks);
      stats.ingested += ticks.length;
      stats.lastIngestAt = Date.now();
    } catch (err) {
      console.error("price-feed: store write failed", err);
      res.status(503).json({ error: "store unavailable" });
      return;
    }

    // THE ENGINE SECOND, and NOT awaited. A dead or slow engine must not slow the feed down or fail
    // the producer's post -- that would make the engine a single point of failure again, by the back
    // door.
    if (tradingCoreUrl) {
      void fanOut(ticks).catch(() => {});
    }

    res.json({ ok: true, count: ticks.length });
  });

  async function fanOut(ticks: Tick[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const r = await fetch(`${tradingCoreUrl}/internal/price-feed`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-price-feed-secret": priceFeedSecret },
        body: JSON.stringify(ticks),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      // Rate-limited, because a down engine would otherwise write a line per tick. The counter is the
      // real signal; see /internal/feed-stats.
      stats.fanoutFailures += 1;
      if (stats.fanoutFailures === 1 || stats.fanoutFailures % 500 === 0) {
        console.warn(
          `price-feed: fan-out to the engine failed (${stats.fanoutFailures} so far)`,
          err instanceof Error ? err.message : err
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // -- READS ---------------------------------------------------------------------------------------
  //
  // Byte-compatible with the engine's `/internal/prices`, because lib/market-data-client.ts parses
  // that exact shape ({symbol, bid, ask, tickAt, updatedAt, ageMs}; 404 for an unknown symbol). The
  // `x-vyx-idle-gate` header is NOT emitted: it is the engine's own view of whether its book can move,
  // which this process has no opinion about, and the web treats it as optional ("absent on an older
  // engine"). Inventing a value would be worse than omitting it.

  const readable = (req: express.Request, res: express.Response): boolean => {
    if (authorised(req.headers["x-market-data-secret"], marketDataReadSecret)) return true;
    res.status(401).send("unauthorized");
    return false;
  };

  app.get("/internal/prices", async (req, res) => {
    if (!readable(req, res)) return;
    try {
      res.json(await store.all());
    } catch (err) {
      console.error("price-feed: /internal/prices failed", err);
      res.status(503).json({ error: "store unavailable" });
    }
  });

  app.get("/internal/prices/:symbol", async (req, res) => {
    if (!readable(req, res)) return;
    try {
      const row = await store.get(req.params.symbol);
      if (!row) {
        // 404 and not an empty 200: the web distinguishes "no such price" (notFound, which is not an
        // alert) from "the read failed" (which is). A symbol whose feed stopped belongs in the first.
        res.status(404).json({ error: "no price for symbol" });
        return;
      }
      res.json(row);
    } catch (err) {
      console.error("price-feed: /internal/prices/:symbol failed", err);
      res.status(503).json({ error: "store unavailable" });
    }
  });

  /** Candles are history and live in Postgres: proxied to the engine, see this file's header. */
  app.get("/internal/candles", async (req, res) => {
    if (!readable(req, res)) return;
    if (!tradingCoreUrl) {
      res.status(503).json({ error: "no candle source configured" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const upstream = await fetch(`${tradingCoreUrl}/internal/candles${qs ? `?${qs}` : ""}`, {
        headers: { "X-Market-Data-Secret": marketDataReadSecret },
        signal: controller.signal,
      });
      res.status(upstream.status).send(await upstream.text());
    } catch (err) {
      console.warn("price-feed: candle proxy failed (charts degrade, orders do not)", err instanceof Error ? err.message : err);
      res.status(503).json({ error: "candle source unavailable" });
    } finally {
      clearTimeout(timer);
    }
  });

  /** Operational counters, same shared-secret convention as the engine's own feed-stats. */
  app.get("/internal/feed-stats", (req, res) => {
    if (!readable(req, res)) return;
    res.json({
      ingested: stats.ingested,
      fanoutFailures: stats.fanoutFailures,
      lastIngestAt: stats.lastIngestAt ? new Date(stats.lastIngestAt).toISOString() : null,
      lastIngestAgeMs: stats.lastIngestAt ? Date.now() - stats.lastIngestAt : null,
      engineFanout: tradingCoreUrl ? "on" : "off",
    });
  });

  return { app, stats };
}
