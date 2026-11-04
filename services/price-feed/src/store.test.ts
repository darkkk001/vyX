// PRIORITY 3: the store's staleness semantics.
//
// This is the file that matters most in this service, because the whole decoupling is only safe if a
// DEAD FEED LOOKS DEAD. The failure everyone fears here is not "no price" -- that is an honest answer
// the web already handles by refusing the order. It is a store that keeps serving the last tick it saw
// as though it were current, which would have the web quoting a price nobody is standing behind.
//
// So the tests below are mostly about time: whose clock decides how old a tick is, and what happens
// when the answer is "too old".
//
// Redis is REAL here (the local throwaway on 6399), not faked. A fake would be asserting that my model
// of SET/GET/SCAN matches ioredis's, which is not the property under test.

import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";

import { MAX_SERVE_AGE_MS, PriceStore } from "./store.js";

const URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6399";
if (!/127\.0\.0\.1|localhost/.test(URL)) {
  throw new Error(`refusing a non-local Redis for tests: ${URL}`);
}

const redis = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
let reachable = true;
try {
  await redis.connect();
  await redis.ping();
} catch {
  reachable = false;
}

const PREFIX = "vyx:price:";
const SYM = () => `TST${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

async function cleanup(symbols: string[]) {
  if (symbols.length) await redis.del(...symbols.map((s) => PREFIX + s));
}

test("a written tick reads back in the engine's own wire shape", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const s = SYM();
  await store.put({ symbol: s, bid: "4000.00", ask: "4000.50" });

  const row = await store.get(s);
  assert.ok(row);
  // lib/market-data-client.ts parses exactly these six fields off the engine today, so the feed has to
  // emit exactly these six or repointing the web at it silently breaks pricing.
  assert.deepEqual(Object.keys(row).sort(), ["ageMs", "ask", "bid", "symbol", "tickAt", "updatedAt"]);
  assert.equal(row.symbol, s);
  assert.equal(row.bid, "4000.00");
  assert.equal(row.ask, "4000.50");
  assert.ok(row.ageMs >= 0 && row.ageMs < 5_000);
  await cleanup([s]);
});

// THE ONE THAT MATTERS. A feed that stopped an hour ago must not read as a fresh price just because
// this process is healthy and wrote the row recently. `t0` is the PRODUCER's clock, and age is measured
// off that -- so a stale producer is visible even behind a lively store.
test("age is measured off the PRODUCER's timestamp, not off when we stored it", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const s = SYM();
  const tenSecondsAgo = Date.now() - 10_000;

  await store.put({ symbol: s, bid: "1", ask: "2", t0: tenSecondsAgo });

  const row = await store.get(s);
  assert.ok(row);
  assert.ok(row.ageMs >= 9_000, `a ten-second-old tick must look ten seconds old, got ageMs=${row.ageMs}`);
  // and the web's own fill rule (FILL_PRICE_MAX_AGE_MS = 3000 in lib/risk.ts) will refuse it, which is
  // the behaviour this test exists to make possible
  assert.ok(row.ageMs > 3_000);
  await cleanup([s]);
});

test("a tick older than the serve window reads as ABSENT, not as a very old price", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const s = SYM();
  await store.put({ symbol: s, bid: "1", ask: "2", t0: Date.now() - (MAX_SERVE_AGE_MS + 5_000) });

  assert.equal(await store.get(s), null, "past the serve window a symbol has no price at all");
  // and it is absent from the list too, so a watchlist does not show a dead quote
  const all = await store.all();
  assert.equal(all.find((r) => r.symbol === s), undefined);
  await cleanup([s]);
});

test("a t0 the producer did not set falls back to our clock rather than to zero", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const s = SYM();
  // 0, negative and NaN are all "not set" -- treating any of them as an epoch timestamp would make
  // every tick look 56 years old and refuse every order
  for (const t0 of [undefined, 0, -1, Number.NaN] as (number | undefined)[]) {
    await store.put({ symbol: s, bid: "1", ask: "2", ...(t0 === undefined ? {} : { t0 }) });
    const row = await store.get(s);
    assert.ok(row, `t0=${t0} produced no row`);
    assert.ok(row.ageMs < 5_000, `t0=${t0} produced ageMs=${row.ageMs}`);
  }
  await cleanup([s]);
});

test("a malformed stored row is dropped, never repaired", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const s = SYM();
  // the store is written by one process and read by another: a shape that does not parse means they
  // disagree about the format, and guessing at a price there is exactly the wrong instinct
  for (const junk of ["not json at all", "{}", '{"symbol":"X","bid":4000}', '{"symbol":"X","bid":"1","ask":"2","tickAt":"nonsense","updatedAt":"x"}']) {
    await redis.set(PREFIX + s, junk);
    assert.equal(await store.get(s), null, `junk accepted: ${junk}`);
  }
  await cleanup([s]);
});

test("a batch writes every tick, and the list returns them all", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  const syms = [SYM(), SYM(), SYM()];
  const n = await store.putMany(syms.map((symbol, i) => ({ symbol, bid: String(100 + i), ask: String(101 + i) })));
  assert.equal(n, 3);

  const all = await store.all();
  for (const s of syms) {
    const row = all.find((r) => r.symbol === s);
    assert.ok(row, `${s} missing from the list`);
  }
  await cleanup(syms);
});

test("an empty batch is a no-op rather than an error", { skip: !reachable && "local Redis not reachable" }, async () => {
  const store = new PriceStore(redis);
  assert.equal(await store.putMany([]), 0);
});

test.after(async () => {
  if (reachable) await redis.quit();
});
