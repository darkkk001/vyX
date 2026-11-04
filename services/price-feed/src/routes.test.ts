// PRIORITY 3: the feed's HTTP surface, over a real socket.
//
// Two properties carry the whole design and both are tested here:
//
//   1. THE STORE WRITE IS AWAITED AND THE FAN-OUT IS NOT. If that were the other way round, a dead
//      engine would slow or fail the producer's post, and the engine would be a single point of
//      failure again through the back door -- which is the exact thing this process exists to remove.
//   2. THE READ SHAPE IS THE ENGINE'S. The web is repointed at this service by changing one
//      environment variable and nothing else, so a field renamed here is a silent pricing outage.
//
// The store is faked (a Map) because what is under test is the routes' behaviour, not Redis; store.ts
// has its own tests against a real Redis.

import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";

import { createApp, type Stats } from "./app.js";
import type { PriceStore, StoredPrice, Tick } from "./store.js";

const FEED_SECRET = "feed-secret-0000000000";
const READ_SECRET = "read-secret-0000000000";

/** A PriceStore-shaped fake that records what it was asked to do. */
function fakeStore() {
  const rows = new Map<string, StoredPrice>();
  let failWrites = false;
  let writeDelayMs = 0;
  const store = {
    async put(t: Tick) {
      await store.putMany([t]);
    },
    async putMany(ticks: Tick[]) {
      if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
      if (failWrites) throw new Error("redis down");
      const now = Date.now();
      for (const t of ticks) {
        rows.set(t.symbol, {
          symbol: t.symbol,
          bid: t.bid,
          ask: t.ask,
          tickAt: new Date(t.t0 && t.t0 > 0 ? t.t0 : now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          ageMs: 0,
        });
      }
      return ticks.length;
    },
    async get(symbol: string) {
      return rows.get(symbol) ?? null;
    },
    async all() {
      return [...rows.values()];
    },
  };
  return {
    store: store as unknown as PriceStore,
    rows,
    setFailWrites: (v: boolean) => {
      failWrites = v;
    },
    setWriteDelay: (ms: number) => {
      writeDelayMs = ms;
    },
  };
}

async function withApp(
  tradingCoreUrl: string,
  fn: (ctx: { base: string; rows: Map<string, StoredPrice>; stats: Stats; f: ReturnType<typeof fakeStore> }) => Promise<void>
) {
  const f = fakeStore();
  const { app, stats } = createApp({
    store: f.store,
    priceFeedSecret: FEED_SECRET,
    marketDataReadSecret: READ_SECRET,
    tradingCoreUrl,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  try {
    await fn({ base: `http://127.0.0.1:${port}`, rows: f.rows, stats, f });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A stand-in engine, so the fan-out has somewhere real to go (or somewhere real to fail). */
async function withEngine(handler: (body: unknown) => { status: number }, fn: (url: string, seen: unknown[]) => Promise<void>) {
  const express = (await import("express")).default;
  const seen: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.post("/internal/price-feed", (req, res) => {
    seen.push(req.body);
    res.status(handler(req.body).status).json({ ok: true });
  });
  app.get("/internal/candles", (_req, res) => {
    res.json([{ bucketStart: "2026-11-04T00:00:00.000Z", open: "1", high: "2", low: "0", close: "1" }]);
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const tick = (symbol = "LSXAU") => ({ symbol, bid: "4000.00", ask: "4000.50", t0: Date.now() });

function post(base: string, body: unknown, secret = FEED_SECRET) {
  return fetch(`${base}/internal/price-feed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-price-feed-secret": secret },
    body: JSON.stringify(body),
  });
}

// ── ingest ────────────────────────────────────────────────────────────────────────────────────────

test("a tick is stored and acknowledged", async () => {
  await withApp("", async ({ base, rows }) => {
    const res = await post(base, tick());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, count: 1 });
    assert.ok(rows.has("LSXAU"));
  });
});

test("a batch is stored", async () => {
  await withApp("", async ({ base, rows }) => {
    const res = await post(base, [tick("AAA"), tick("BBB")]);
    assert.deepEqual(await res.json(), { ok: true, count: 2 });
    assert.equal(rows.size, 2);
  });
});

test("ingest without the right secret is refused and stores nothing", async () => {
  await withApp("", async ({ base, rows }) => {
    for (const secret of ["", "wrong", FEED_SECRET + "x"]) {
      const res = await post(base, tick(), secret);
      assert.equal(res.status, 401, `secret ${secret!r_placeholder = ""} accepted`);
    }
    assert.equal(rows.size, 0);
  });
});

test("a body with no usable tick is a 400, not a silent success", async () => {
  await withApp("", async ({ base, rows }) => {
    for (const body of [null, [], {}, { symbol: "X" }, { symbol: "X", bid: 4000, ask: 4001 }, [{ bid: "1", ask: "2" }]]) {
      const res = await post(base, body);
      assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    assert.equal(rows.size, 0);
  });
});

test("a store that cannot be written answers 503 rather than pretending", async () => {
  await withApp("", async ({ base, f }) => {
    f.setFailWrites(true);
    const res = await post(base, tick());
    assert.equal(res.status, 503);
  });
});

// ── the fan-out, which is the half that must NOT block ────────────────────────────────────────────

test("the engine receives the ticks by fan-out", async () => {
  await withEngine(() => ({ status: 200 }), async (engineUrl, seen) => {
    await withApp(engineUrl, async ({ base }) => {
      await post(base, tick());
      // not awaited by the route, so give the microtask a moment -- this is the only sleep in the file
      // and it is here precisely because the fan-out is asynchronous by design
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(seen.length, 1);
      assert.deepEqual((seen[0] as Tick[])[0].symbol, "LSXAU");
    });
  });
});

// THE PROPERTY THE WHOLE SERVICE EXISTS FOR. A dead engine must cost the feed nothing.
test("a DEAD engine does not fail the ingest, and does not slow it either", async () => {
  // a port nothing is listening on: connection refused, the fastest form of dead
  await withApp("http://127.0.0.1:9", async ({ base, rows, stats }) => {
    const startedAt = Date.now();
    const res = await post(base, tick());
    const elapsed = Date.now() - startedAt;

    assert.equal(res.status, 200, "the producer must not see an engine problem as a feed problem");
    assert.ok(rows.has("LSXAU"), "and the store -- the thing the web reads -- still has the tick");
    assert.ok(elapsed < 500, `ingest waited on the dead engine: ${elapsed} ms`);

    await new Promise((r) => setTimeout(r, 150));
    assert.ok(stats.fanoutFailures >= 1, "the failure is counted, not swallowed");
  });
});

test("an engine answering 500 is also just a counted fan-out failure", async () => {
  await withEngine(() => ({ status: 500 }), async (engineUrl) => {
    await withApp(engineUrl, async ({ base, stats }) => {
      assert.equal((await post(base, tick())).status, 200);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(stats.fanoutFailures >= 1);
    });
  });
});

// ── reads: the contract the web already speaks ────────────────────────────────────────────────────

test("GET /internal/prices/:symbol emits exactly the engine's six fields", async () => {
  await withApp("", async ({ base }) => {
    await post(base, tick());
    const res = await fetch(`${base}/internal/prices/LSXAU`, { headers: { "X-Market-Data-Secret": READ_SECRET } });
    assert.equal(res.status, 200);
    const row = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["ageMs", "ask", "bid", "symbol", "tickAt", "updatedAt"]);
    assert.equal(typeof row.bid, "string", "decimals stay strings -- a float here loses precision");
    assert.equal(typeof row.ask, "string");
  });
});

test("GET /internal/prices emits a list", async () => {
  await withApp("", async ({ base }) => {
    await post(base, [tick("AAA"), tick("BBB")]);
    const res = await fetch(`${base}/internal/prices`, { headers: { "X-Market-Data-Secret": READ_SECRET } });
    const rows = (await res.json()) as unknown[];
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);
  });
});

// 404 and not an empty 200: lib/market-data-client.ts treats notFound as "this symbol has no price"
// (no alert) and any other failure as a price-source outage (alert). Collapsing them would either
// alert on every unticked symbol or hide a real outage.
test("an unknown symbol is 404, which the web reads as notFound rather than as an outage", async () => {
  await withApp("", async ({ base }) => {
    const res = await fetch(`${base}/internal/prices/NOPE`, { headers: { "X-Market-Data-Secret": READ_SECRET } });
    assert.equal(res.status, 404);
  });
});

test("reads without the read secret are refused", async () => {
  await withApp("", async ({ base }) => {
    for (const path of ["/internal/prices", "/internal/prices/LSXAU", "/internal/candles", "/internal/feed-stats"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, `${path} served without a secret`);
    }
  });
});

// The ingest secret must not open the read API and vice versa: they are separate secrets on purpose
// (the read one is given to the web, which must never hold anything that can write prices).
test("the two secrets are not interchangeable", async () => {
  await withApp("", async ({ base }) => {
    const r = await fetch(`${base}/internal/prices`, { headers: { "X-Market-Data-Secret": FEED_SECRET } });
    assert.equal(r.status, 401);
    const w = await post(base, tick(), READ_SECRET);
    assert.equal(w.status, 401);
  });
});

test("candles are proxied to the engine", async () => {
  await withEngine(() => ({ status: 200 }), async (engineUrl) => {
    await withApp(engineUrl, async ({ base }) => {
      const res = await fetch(`${base}/internal/candles?symbol=LSXAU&timeframe=M1&limit=1`, {
        headers: { "X-Market-Data-Secret": READ_SECRET },
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
    });
  });
});

// Charts degrade, orders do not. This is the asymmetry the whole priority is about, so it is asserted
// rather than left as a comment: with the engine gone, candles fail AND prices still work.
test("with the engine gone candles fail, and prices do not", async () => {
  await withApp("http://127.0.0.1:9", async ({ base }) => {
    await post(base, tick());

    const candles = await fetch(`${base}/internal/candles?symbol=LSXAU&timeframe=M1`, {
      headers: { "X-Market-Data-Secret": READ_SECRET },
    });
    assert.equal(candles.status, 503, "candles need the engine and say so");

    const price = await fetch(`${base}/internal/prices/LSXAU`, { headers: { "X-Market-Data-Secret": READ_SECRET } });
    assert.equal(price.status, 200, "prices do NOT need the engine -- the point of the whole service");
  });
});

test("feed-stats reports what an operator needs to see", async () => {
  await withApp("", async ({ base }) => {
    await post(base, [tick("AAA"), tick("BBB")]);
    const res = await fetch(`${base}/internal/feed-stats`, { headers: { "X-Market-Data-Secret": READ_SECRET } });
    const s = (await res.json()) as Record<string, unknown>;
    assert.equal(s.ingested, 2);
    assert.equal(s.engineFanout, "off");
    assert.equal(typeof s.lastIngestAgeMs, "number");
  });
});

test("health needs no secret, so a supervisor can watch it", async () => {
  await withApp("", async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
