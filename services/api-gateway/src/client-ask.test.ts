// client-ask.ts pinned to the shared contract (docs/contracts/ask-markup-vectors.json, generated from the web's own
// lib/ask-markup.ts): the stream's per-account ask must equal the price the web fills at, for every vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import { resolveRule, clientAsk, clientBid, rewriteTick, markupParts, type AskRule } from "./client-ask.js";

const v = JSON.parse(readFileSync(new URL("../../../docs/contracts/ask-markup-vectors.json", import.meta.url), "utf-8"));
const D = (x: unknown) => (x == null ? null : new Decimal(String(x)));
const lvl = (l: { spreadMarkup: string | null; targetTotalSpreadPips: string | null } | null) => ({ markup: D(l?.spreadMarkup), target: D(l?.targetTotalSpreadPips) });

test("every resolution vector: the stream resolves the same rule as the web", () => {
  for (const c of v.resolution) {
    const r = resolveRule({ engine: c.pricingEngineEnabled, coverage: c.coverage, digits: c.digits, broker: D(c.broker), group: lvl(c.group), account: lvl(c.accountSymbol) });
    const got = r.mode === "markup" ? { mode: "markup", markupPips: r.markupPips.toString() } : { mode: "target", targetPips: r.targetPips.toString(), fallbackPips: r.fallbackPips?.toString() ?? null };
    assert.deepEqual(got, c.expected, c.name);
  }
});

test("every price vector: the stream's BOTH sides equal the web's account bid and ask", () => {
  for (const c of v.prices) {
    const rule: AskRule = c.rule.mode === "markup"
      ? { mode: "markup", markupPips: new Decimal(c.rule.markupPips), digits: c.digits }
      : { mode: "target", targetPips: new Decimal(c.rule.targetPips), fallbackPips: D(c.rule.fallbackPips), digits: c.digits };
    assert.equal(clientAsk(rule, c.bid, c.ask).toString(), new Decimal(c.expected.accountAsk).toString(), `${c.name}: ask`);
    // symmetric markup (2026-10-29): the bid is marked DOWN by the same half, so it is pinned by the contract too
    assert.equal(clientBid(rule, c.bid, c.ask).toString(), new Decimal(c.expected.accountBid).toString(), `${c.name}: bid`);
    // A zero spread became legitimate with the negative markup (both sides sit on the mid), so the strict
    // `<` only still holds where the markup is non-negative -- asserted separately rather than dropped, so
    // a normal group still cannot be given a zero spread by a sign error.
    const negative = c.rule.mode === "markup" && new Decimal(c.rule.markupPips).isNegative();
    assert.ok(clientBid(rule, c.bid, c.ask).lte(clientAsk(rule, c.bid, c.ask)), `${c.name}: must not invert`);
    if (!negative) {
      assert.ok(clientBid(rule, c.bid, c.ask).lt(clientAsk(rule, c.bid, c.ask)), `${c.name}: must not cross`);
    }
  }
});

test("a rewritten tick carries the account's bid AND ask in place of the raw ones, nothing else changes, same JSON type", () => {
  const rule: AskRule = { mode: "markup", markupPips: new Decimal("1.5"), digits: 2 };
  const out = JSON.parse(rewriteTick({ symbol: "XAUUSD", bid: "4298.96", ask: "4299.13", t0: 1 }, rule));
  // 1.5 pips = 15 points: ask +8 to 4299.21, bid -7 to 4298.89, a total of exactly 15
  assert.deepEqual(out, { symbol: "XAUUSD", bid: "4298.89", ask: "4299.21", t0: 1 });
  assert.ok(!JSON.stringify(out).includes("4299.13"), "the raw ask must not reach the trader");
  assert.ok(!JSON.stringify(out).includes("4298.96"), "the raw bid must not reach the trader either");
  const num = JSON.parse(rewriteTick({ symbol: "X", bid: 1.1, ask: 1.2 }, { mode: "markup", markupPips: new Decimal(0), digits: 1 }));
  assert.equal(typeof num.ask, "number");
  assert.equal(typeof num.bid, "number");
});

// ---- Neon compute: rule reads are event-driven, never per tick (coordinator 2026-10-01) ----
import { ClientAskRegistry, ASK_SAFETY_RELOAD_MS, ASK_RETRY_MS } from "./client-ask.js";

const flush = () => new Promise((r) => setImmediate(r));
function harness(opts: { fail?: () => boolean } = {}) {
  let t = 1_000_000;
  const calls: string[][] = [];
  const query = async (_sql: string, params: unknown[]) => {
    calls.push(params[0] as string[]);
    if (opts.fail?.()) throw new Error("db down");
    const ids = params[0] as string[];
    return { rows: ids.map((id) => ({ account_id: id, name: "XAUUSD", digits: 2, engine: true, coverage: false, broker_m: "1.5", g_m: null, g_t: null, a_m: null, a_t: null })) };
  };
  const reg = new ClientAskRegistry(query, () => t, () => {});
  return { reg, calls, advance: (ms: number) => (t += ms) };
}
const TICK = { symbol: "XAUUSD", bid: "4298.96", ask: "4299.13" };
const RAW = JSON.stringify(TICK);
const ticks = (reg: ClientAskRegistry, acc: string, broker: string, n: number) => Array.from({ length: n }, () => reg.frameFor(acc, broker, "XAUUSD", TICK, RAW));

test("a switched-off broker: raw ticks, ZERO rule reads (sockets, 1000 ticks, config and account events)", async () => {
  const { reg, calls } = harness();
  reg.setBrokerFlag("b1", false);
  reg.addSocket("a1", "b1");
  reg.addSocket("a2", "b1");
  const out = [...ticks(reg, "a1", "b1", 500), ...ticks(reg, "a2", "b1", 500)];
  reg.onConfigChanged("b1");
  reg.onAccountUpdated("a1");
  await flush();
  assert.equal(calls.length, 0);
  assert.ok(out.every((f) => f === RAW));
});

test("a switched-on broker: 1 read per socket open, 1 per config event (all its traders), 1 per AccountUpdated, 1 per 10-min safety reload; none per tick", async () => {
  const { reg, calls, advance } = harness();
  reg.setBrokerFlag("b1", true); // no trader connected yet: nothing to read
  assert.equal(calls.length, 0);
  reg.addSocket("a1", "b1");
  assert.deepEqual(ticks(reg, "a1", "b1", 50), Array(50).fill(null), "held (never raw) until the rules are loaded");
  await flush();
  assert.equal(calls.length, 1, "socket open = 1 read, the held ticks did not add any");
  const frames = ticks(reg, "a1", "b1", 1000);
  assert.ok(frames.every((f) => f !== null && JSON.parse(f).ask === "4299.21" && !f.includes("4299.13")));
  reg.addSocket("a2", "b1");
  await flush();
  assert.equal(calls.length, 2);
  reg.onConfigChanged("b1");
  await flush();
  assert.equal(calls.length, 3);
  assert.deepEqual([...calls[2]].sort(), ["a1", "a2"], "one read for every connected trader of the broker");
  reg.onAccountUpdated("a2");
  await flush();
  assert.deepEqual(calls[3], ["a2"]);
  ticks(reg, "a1", "b1", 1000);
  assert.equal(calls.length, 4);
  advance(ASK_SAFETY_RELOAD_MS);
  ticks(reg, "a1", "b1", 1000);
  await flush();
  assert.equal(calls.length, 5, "the 10-minute safety reload is one read, whatever the tick count");
});

test("the switch turning on while traders are connected: one read loads them all; turning off is raw at once with no read", async () => {
  const { reg, calls } = harness();
  reg.setBrokerFlag("b1", false);
  reg.addSocket("a1", "b1");
  reg.addSocket("a2", "b1");
  assert.equal(reg.setBrokerFlag("b1", true), true);
  assert.equal(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW), null);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(reg.frameFor("a2", "b1", "XAUUSD", TICK, RAW)!).ask, "4299.21");
  assert.equal(reg.setBrokerFlag("b1", true), false, "already on: no reload");
  reg.setBrokerFlag("b1", false);
  assert.equal(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW), RAW);
  assert.equal(calls.length, 1);
});

test("unknown switch = held; a failed read is retried at most every 30 s, never per tick; other brokers unaffected", async () => {
  let down = true;
  const { reg, calls, advance } = harness({ fail: () => down });
  reg.addSocket("a1", "b1");
  assert.equal(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW), null, "switch not read yet: held");
  reg.setBrokerFlag("b2", false);
  reg.addSocket("x1", "b2");
  reg.setBrokerFlag("b1", true);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(ticks(reg, "a1", "b1", 500), Array(500).fill(null));
  await flush();
  assert.equal(calls.length, 1, "no retry inside 30 s");
  assert.equal(reg.frameFor("x1", "b2", "XAUUSD", TICK, RAW), RAW, "a switched-off broker keeps its raw ticks");
  down = false;
  advance(ASK_RETRY_MS);
  ticks(reg, "a1", "b1", 500);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW)!).ask, "4299.21");
});

test("sockets are ref-counted per account: the last close drops the rules, a reconnect reads once", async () => {
  const { reg, calls } = harness();
  reg.setBrokerFlag("b1", true);
  reg.addSocket("a1", "b1");
  reg.addSocket("a1", "b1");
  await flush();
  assert.equal(calls.length, 1, "a second socket of a loaded account reads nothing");
  reg.removeSocket("a1");
  assert.notEqual(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW), null);
  reg.removeSocket("a1");
  assert.equal(reg.stats().askAccountsLoaded, 0);
  reg.addSocket("a1", "b1");
  await flush();
  assert.equal(calls.length, 2);
});

// ── the negative-markup property tests, aligned with the web twin (65cd69de) and the engine twin ──
//
// THREE implementations now compute this one rule: the web's lib/ask-markup.ts, the engine's
// market-data/src/ask_markup.rs, and this file. This one is the only one that prices the ticks
// futurixglobal's clients actually see (its clientAskServerSideAt is SET, so the stream is rewritten
// server-side here, not in the terminal), so it carries the same hostile property test as the other
// two -- same linear congruential generator, same seed (20261110), same digit set, same ranges, so a
// disagreement between any two of the three lands on the same numbered case.
//
// The five invariants are the web's, in its order: never crossed; never wider than raw; exactly the
// half-even mid when floored; otherwise each side still on its own side of the raw mid; and the fill
// equal to the quote.
test("negative markup: 3000 hostile cases tighten the book but never past the mid", () => {
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let collapsed = 0, tightened = 0;
  for (let i = 0; i < 3000; i++) {
    const digits = [1, 2, 3, 5][Math.floor(rnd() * 4)];
    const point = new Decimal(1).div(new Decimal(10).pow(digits));
    const bid = new Decimal(Math.floor(1000 + rnd() * 100000)).mul(point);
    const ask = bid.add(point.mul(Math.floor(rnd() * 60)));                  // raw spread 0..59 points
    const markupPips = new Decimal(-(Math.floor(rnd() * 4000) + 1)).div(10); // -0.1 .. -400 pips
    const rule: AskRule = { mode: "markup", markupPips, digits };
    const qa = clientAsk(rule, bid, ask);
    const qb = clientBid(rule, bid, ask);
    const rawMid = bid.add(ask).div(2);
    const midHe = rawMid.toDecimalPlaces(digits, Decimal.ROUND_HALF_EVEN);
    const where = `case ${i} (raw ${bid}/${ask}, ${markupPips} pips, ${digits} digits)`;
    assert.ok(qb.lte(qa), `crossed book ${qb}/${qa} -- ${where}`);
    assert.ok(qb.gte(bid) && qa.lte(ask), `wider than raw ${qb}/${qa} -- ${where}`);
    if (qb.eq(qa)) {
      collapsed++;
      assert.ok(qb.eq(midHe), `collapsed to ${qb}, not the half-even mid ${midHe} -- ${where}`);
    } else {
      tightened++;
      assert.ok(qb.lte(rawMid) && qa.gte(rawMid), `a side passed the mid: ${qb}/${qa} around ${rawMid} -- ${where}`);
    }
  }
  // Coverage, measured: these shared ranges put the markup far above the raw spread on almost every
  // draw, so the collapsed branch dominates and the tightened one -- the branch the 2026-10-29 pentest
  // finding actually lived in -- gets only a handful of cases. Same on all three sides, since the
  // ranges are shared. The next test is what covers it properly here.
  assert.ok(collapsed > 2000, `expected the collapsed branch to dominate, got ${collapsed}`);
  assert.ok(tightened >= 10, `the tightened branch must still be exercised, got ${tightened}`);

  // the web's worked example, identical: -500 pips on 2000.00 / 2000.30 collapses to the mid, not 1950
  const r: AskRule = { mode: "markup", markupPips: new Decimal(-500), digits: 2 };
  assert.equal(clientAsk(r, "2000.00", "2000.30").toString(), "2000.15");
  assert.equal(clientBid(r, "2000.00", "2000.30").toString(), "2000.15");
});

// The tightened branch, covered properly: the markup is drawn to be strictly SMALLER than the raw
// spread, so every case narrows the book without reaching the mid. It also pins exactness -- the
// client spread must come out at raw + markup to the point, which is the contract with max() not yet
// binding -- and that the BID takes the larger share of an odd total (ceil moves toward zero).
test("negative markup: tightening is exact, and the bid takes the larger half", () => {
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let kept = 0, attempts = 0;
  while (kept < 3000 && attempts < 200000) {
    attempts++;
    const digits = [1, 2, 3, 5][Math.floor(rnd() * 4)];
    const point = new Decimal(1).div(new Decimal(10).pow(digits));
    const bid = new Decimal(Math.floor(1000 + rnd() * 100000)).mul(point);
    const spreadPoints = 2 + Math.floor(rnd() * 58);
    const ask = bid.add(point.mul(spreadPoints));
    const markupPips = new Decimal(-(Math.floor(rnd() * 60) + 1)).div(10); // -0.1 .. -6.0 pips
    const rule: AskRule = { mode: "markup", markupPips, digits };
    const parts = markupParts(rule, bid, ask);
    const totalPoints = parts.ask.add(parts.bid).div(point).neg();
    if (totalPoints.lt(1) || totalPoints.gte(spreadPoints)) continue; // collapses: the other test's job
    kept++;

    const qa = clientAsk(rule, bid, ask);
    const qb = clientBid(rule, bid, ask);
    const rawMid = bid.add(ask).div(2);
    const where = `case ${kept} (raw spread ${spreadPoints} pts, markup -${totalPoints} pts, ${digits} digits)`;
    assert.ok(qb.lt(qa), `collapsed although the markup is narrower than the spread -- ${where}`);
    assert.ok(qb.lte(rawMid) && qa.gte(rawMid), `a side passed the mid: ${qb}/${qa} -- ${where}`);
    assert.ok(qb.gte(bid) && qa.lte(ask), `wider than raw: ${qb}/${qa} -- ${where}`);
    assert.equal(qa.sub(qb).div(point).toString(), new Decimal(spreadPoints).sub(totalPoints).toString(),
      `client spread must be raw + markup exactly -- ${where}`);
    const up = qb.sub(bid).div(point);
    const down = ask.sub(qa).div(point);
    assert.equal(up.add(down).toString(), totalPoints.toString(), `the two sides must account for the whole markup -- ${where}`);
    assert.ok(up.gte(down), `on a negative total the BID takes the larger share, got bid +${up} / ask -${down} -- ${where}`);
  }
  assert.equal(kept, 3000, `only ${kept} tightening cases found in ${attempts} attempts`);
});

// The other half of the pair (seed 7, 2000 cases): a markup of zero or more still never tightens.
// The regression guard for every NORMAL group -- the whole-point split is untouched by the negative branch.
test("a markup of 0 or more never tightens either side (2000 cases)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    const digits = [1, 2, 3, 5][Math.floor(rnd() * 4)];
    const point = new Decimal(1).div(new Decimal(10).pow(digits));
    const bid = new Decimal(Math.floor(1000 + rnd() * 100000)).mul(point);
    const ask = bid.add(point.mul(1 + Math.floor(rnd() * 60)));
    const rule: AskRule = { mode: "markup", markupPips: new Decimal(Math.floor(rnd() * 300)).div(10), digits };
    const qa = clientAsk(rule, bid, ask);
    const qb = clientBid(rule, bid, ask);
    assert.ok(qa.gte(ask) && qb.lte(bid) && qb.lt(qa), `case ${i}: a non-negative markup tightened the book -- ${qb}/${qa} vs raw ${bid}/${ask}`);
  }
});
