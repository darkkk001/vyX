// client-ask.ts pinned to the shared contract (docs/contracts/ask-markup-vectors.json, generated from the web's own
// lib/ask-markup.ts): the stream's per-account ask must equal the price the web fills at, for every vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Decimal } from "decimal.js";
import { resolveRule, clientAsk, rewriteTick, type AskRule } from "./client-ask.js";

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

test("every price vector: the stream's ask equals the web's account ask", () => {
  for (const c of v.prices) {
    const rule: AskRule = c.rule.mode === "markup"
      ? { mode: "markup", markupPips: new Decimal(c.rule.markupPips), digits: c.digits }
      : { mode: "target", targetPips: new Decimal(c.rule.targetPips), fallbackPips: D(c.rule.fallbackPips), digits: c.digits };
    assert.equal(clientAsk(rule, c.bid, c.ask).toString(), new Decimal(c.expected.accountAsk).toString(), c.name);
  }
});

test("a rewritten tick carries the account's ask in place of the raw ask, nothing else changes, same JSON type", () => {
  const rule: AskRule = { mode: "markup", markupPips: new Decimal("1.5"), digits: 2 };
  const out = JSON.parse(rewriteTick({ symbol: "XAUUSD", bid: "4298.96", ask: "4299.13", t0: 1 }, rule));
  assert.deepEqual(out, { symbol: "XAUUSD", bid: "4298.96", ask: "4299.28", t0: 1 });
  assert.ok(!JSON.stringify(out).includes("4299.13"), "the raw ask must not reach the trader");
  const num = JSON.parse(rewriteTick({ symbol: "X", bid: 1.1, ask: 1.2 }, { mode: "markup", markupPips: new Decimal(0), digits: 1 }));
  assert.equal(typeof num.ask, "number");
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
  assert.ok(frames.every((f) => f !== null && JSON.parse(f).ask === "4299.28" && !f.includes("4299.13")));
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
  assert.equal(JSON.parse(reg.frameFor("a2", "b1", "XAUUSD", TICK, RAW)!).ask, "4299.28");
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
  assert.equal(JSON.parse(reg.frameFor("a1", "b1", "XAUUSD", TICK, RAW)!).ask, "4299.28");
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
