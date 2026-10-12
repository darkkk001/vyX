import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { DEMO_GRID_MS, DEMO_SYMBOLS, demoDef, demoQuoteAt } from "@/lib/demo-prices";
import { simulateSweep, type SimAccount, type SimOrder, type SimPos, type SweepEvent, type SweepPorts } from "@/lib/demo-sweep-core";
import { closePriceFor, computeRealizedPnl } from "@/lib/trading";
import { checkPreTradeMargin, hedgedUsedMargin, liveUsedMarginFor, type MarginLeg } from "@/lib/margin";

// The lazy replay of the demo's risk (lib/demo-sweep-core.ts): SL, TP, stop-out and pending fills found on the deterministic
// path between two moments, at the right time and price, in order, once. The skipping walk is checked against a plain
// tick-by-tick oracle written independently below.

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const G = DEMO_GRID_MS;
const T0 = Date.UTC(2026, 9, 12, 8, 0, 0, 0) + 37; // 37 ms off the grid on purpose
const HOUR = 3_600_000;

const bid = (sym: string, t: number) => D(demoQuoteAt(sym, t)!.bid);
const ask = (sym: string, t: number) => D(demoQuoteAt(sym, t)!.ask);
const tickAtOrAfter = (ms: number) => Math.ceil(ms / G) * G;

function pos(id: string, sym: string, side: "BUY" | "SELL", volume: string, openMs: number, extra: Partial<SimPos> = {}): SimPos {
  const def = demoDef(sym)!;
  const open = side === "BUY" ? ask(sym, openMs) : bid(sym, openMs);
  return { id, side, volume: D(volume), openPrice: open, slPrice: null, tpPrice: null, symbol: sym, contractSize: D(def.contractSize), quoteCurrency: def.quoteCurrency, openedMs: openMs, hedgedMarginPct: D(200), ...extra };
}
const account = (extra: Partial<SimAccount> = {}): SimAccount => ({ balance: D(10000), credit: D(0), leverage: 100, stopOutLevel: D(50), marginCallLevel: D(100), ...extra });

// In-memory ports: the same money rules as closePositionInTx (P&L x rate, the balance floored at zero)
function fakePorts(acct: { balance: Prisma.Decimal }, log: SweepEvent[] = []) {
  const closedIds = new Set<string>();
  let n = 0;
  const ports: SweepPorts = {
    async closePosition(p, closePrice, atMs) {
      if (closedIds.has(p.id)) return { closed: false, balance: acct.balance, credit: D(0) };
      closedIds.add(p.id);
      const def = demoDef(p.symbol)!;
      const q = demoQuoteAt("qUSDJPY", atMs)!;
      const rate = def.quoteCurrency === "USD" ? D(1) : D(1).div(D(q.bid).add(D(q.ask)).div(2));
      const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice, volume: p.volume, contractSize: p.contractSize }).mul(rate);
      const next = acct.balance.add(pnl);
      acct.balance = next.isNegative() ? D(0) : next;
      return { closed: true, balance: acct.balance, credit: D(0) };
    },
    async fillPending(o, fillPrice, atMs) {
      const def = demoDef(o.symbol)!;
      return { id: `pos-of-${o.id}-${++n}`, side: o.side, volume: o.volume, openPrice: fillPrice, slPrice: o.slPrice, tpPrice: o.tpPrice, symbol: o.symbol, contractSize: D(def.contractSize), quoteCurrency: def.quoteCurrency, openedMs: atMs, hedgedMarginPct: D(200) };
    },
    async rejectPending() {},
  };
  void log;
  return ports;
}

// ---- the oracle: every tick, no skipping, exact Decimal everywhere ----
async function oracle(args: { account: SimAccount; positions: SimPos[]; orders: SimOrder[]; fromMs: number; toMs: number; hedgingAllowed?: boolean }) {
  const acct = { ...args.account };
  const ports = fakePorts(acct);
  let positions = [...args.positions].sort((a, b) => a.openedMs - b.openedMs || (a.id < b.id ? -1 : 1));
  let orders = [...args.orders];
  const events: SweepEvent[] = [];
  const rate = (p: { quoteCurrency: string }, t: number) => (p.quoteCurrency === "USD" ? D(1) : D(1).div(D(demoQuoteAt("qUSDJPY", t)!.bid).add(D(demoQuoteAt("qUSDJPY", t)!.ask)).div(2)));
  const measure = (set: SimPos[], t: number) => {
    let equity = acct.balance.add(acct.credit);
    const legs: MarginLeg[] = [];
    let worst: { p: SimPos; pnl: Prisma.Decimal; cp: Prisma.Decimal } | null = null;
    for (const p of set) {
      const b = bid(p.symbol, t);
      const a = ask(p.symbol, t);
      const cp = closePriceFor(p.side, b, a);
      const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.contractSize }).mul(rate(p, t));
      equity = equity.add(pnl);
      legs.push({ symbolKey: p.symbol, side: p.side, volume: p.volume, margin: liveUsedMarginFor({ side: p.side, volume: p.volume, contractSize: p.contractSize, bid: b, ask: a, leverage: acct.leverage }).mul(rate(p, t)), hedgedMarginPct: p.hedgedMarginPct });
      if (!worst || pnl.lt(worst.pnl)) worst = { p, pnl, cp };
    }
    const used = hedgedUsedMargin(legs);
    return { equity, used, level: used.gt(0) ? equity.div(used).mul(100) : null, worst };
  };
  for (let t = (Math.floor(args.fromMs / G) + 1) * G; t <= args.toMs; t += G) {
    for (const o of [...orders]) {
      if (!(o.createdMs < t)) continue;
      const q = demoQuoteAt(o.symbol, t)!;
      const entry = o.entry;
      const hit = o.side === "BUY" ? (o.type === "LIMIT" ? D(q.ask).lte(entry) : D(q.ask).gte(entry)) : o.type === "LIMIT" ? D(q.bid).gte(entry) : D(q.bid).lte(entry);
      if (!hit) continue;
      const fill = D(o.side === "BUY" ? q.ask : q.bid);
      const m = measure(positions.filter((p) => p.openedMs <= t), t);
      const def = demoDef(o.symbol)!;
      const required = o.volume.mul(def.contractSize).mul(fill).div(acct.leverage).mul(rate({ quoteCurrency: def.quoteCurrency }, t));
      orders = orders.filter((x) => x.id !== o.id);
      if (checkPreTradeMargin({ equity: m.equity, usedMargin: m.used, requiredMargin: required, marginCallLevel: acct.marginCallLevel })) {
        events.push({ kind: "reject", atMs: t, orderId: o.id, reason: "INSUFFICIENT_MARGIN" });
        continue;
      }
      const np = (await ports.fillPending(o, fill, t))!;
      positions.push(np);
      positions.sort((a, b) => a.openedMs - b.openedMs || (a.id < b.id ? -1 : 1));
      events.push({ kind: "fill", atMs: t, orderId: o.id, positionId: np.id, price: fill.toString() });
    }
    for (const p of [...positions]) {
      if (!(p.openedMs < t)) continue;
      const q = demoQuoteAt(p.symbol, t)!;
      const cp = D(p.side === "BUY" ? q.bid : q.ask);
      let reason: "stop_loss" | "take_profit" | null = null;
      if (p.side === "BUY") {
        if (p.slPrice && cp.lte(p.slPrice)) reason = "stop_loss";
        else if (p.tpPrice && cp.gte(p.tpPrice)) reason = "take_profit";
      } else {
        if (p.slPrice && cp.gte(p.slPrice)) reason = "stop_loss";
        else if (p.tpPrice && cp.lte(p.tpPrice)) reason = "take_profit";
      }
      if (!reason) continue;
      positions = positions.filter((x) => x.id !== p.id);
      const r = await ports.closePosition(p, cp, t, "");
      if (r.closed) events.push({ kind: "close", atMs: t, positionId: p.id, reason, price: cp.toString() });
    }
    for (;;) {
      const open = positions.filter((p) => p.openedMs <= t);
      if (open.length === 0) break;
      const m = measure(open, t);
      if (m.level == null || m.level.gt(acct.stopOutLevel) || !m.worst) break;
      positions = positions.filter((x) => x.id !== m.worst!.p.id);
      const r = await ports.closePosition(m.worst.p, m.worst.cp, t, "");
      if (r.closed) events.push({ kind: "close", atMs: t, positionId: m.worst.p.id, reason: "stop_out", price: m.worst.cp.toString() });
    }
    if (positions.length + orders.length === 0) break;
  }
  return { events, balance: acct.balance, positions, orders };
}

async function run(args: { account: SimAccount; positions: SimPos[]; orders?: SimOrder[]; fromMs: number; toMs: number }) {
  const acct = { balance: args.account.balance };
  const res = await simulateSweep({ account: args.account, positions: args.positions, orders: args.orders ?? [], rules: { hedgingAllowed: true, maxOpenPositions: null }, fromMs: args.fromMs, toMs: args.toMs, ports: fakePorts(acct) });
  return { res, balance: acct.balance };
}

/** the first grid tick after `startMs` where `pred` holds, scanning up to `maxTicks` */
function firstTick(sym: string, startMs: number, maxTicks: number, pred: (b: Prisma.Decimal, a: Prisma.Decimal) => boolean): number | null {
  for (let t = (Math.floor(startMs / G) + 1) * G, i = 0; i < maxTicks; t += G, i++) if (pred(bid(sym, t), ask(sym, t))) return t;
  return null;
}

describe("demo sweep: stop loss and take profit", () => {
  it("a BUY stop loss in the past closes on the tick that crossed it, at that tick's bid", async () => {
    const p = pos("p1", "qXAUUSD", "BUY", "0.10", T0);
    const sl = p.openPrice.sub(4);
    const k = firstTick("qXAUUSD", T0, 8 * 3600 * 4, (b) => b.lte(sl));
    expect(k).not.toBeNull();
    const { res, balance } = await run({ account: account(), positions: [{ ...p, slPrice: sl }], fromMs: T0, toMs: T0 + 12 * HOUR });
    expect(res.events).toEqual([{ kind: "close", atMs: k!, positionId: "p1", reason: "stop_loss", price: bid("qXAUUSD", k!).toString() }]);
    // the loss is booked at that price: 0.10 lot x 100 oz x (bid - open)
    expect(balance.toString()).toBe(D(10000).add(bid("qXAUUSD", k!).sub(p.openPrice).mul(10)).toString());
    expect(res.complete).toBe(true);
  });
  it("a SELL take profit closes at the ask of the crossing tick", async () => {
    const p = pos("p2", "qEURUSD", "SELL", "1", T0);
    const tp = p.openPrice.sub("0.0012");
    const k = firstTick("qEURUSD", T0, 6 * 3600 * 4, (_b, a) => a.lte(tp));
    expect(k).not.toBeNull();
    const { res } = await run({ account: account(), positions: [{ ...p, tpPrice: tp }], fromMs: T0, toMs: T0 + 10 * HOUR });
    expect(res.events).toEqual([{ kind: "close", atMs: k!, positionId: "p2", reason: "take_profit", price: ask("qEURUSD", k!).toString() }]);
  });
  it("nothing happens when no level is touched, and the position stays open", async () => {
    const p = pos("p3", "qXAUUSD", "BUY", "0.01", T0, { slPrice: D("1000"), tpPrice: D("9000") });
    const { res } = await run({ account: account(), positions: [p], fromMs: T0, toMs: T0 + 24 * HOUR });
    expect(res.events).toEqual([]);
    expect(res.positions.map((x) => x.id)).toEqual(["p3"]);
  });
  it("re-running from where the first run stopped finds nothing twice (idempotent)", async () => {
    const p = pos("p1", "qXAUUSD", "BUY", "0.10", T0);
    const sl = p.openPrice.sub(4);
    const first = await run({ account: account(), positions: [{ ...p, slPrice: sl }], fromMs: T0, toMs: T0 + 12 * HOUR });
    expect(first.res.events).toHaveLength(1);
    const again = await run({ account: account(), positions: first.res.positions, fromMs: first.res.reachedMs, toMs: T0 + 12 * HOUR });
    expect(again.res.events).toEqual([]);
    // and splitting the window in two gives the same single event as one long window
    const mid = T0 + 3 * HOUR;
    const a = await run({ account: account(), positions: [{ ...p, slPrice: sl }], fromMs: T0, toMs: mid });
    const b = await run({ account: account(), positions: a.res.positions, fromMs: mid, toMs: T0 + 12 * HOUR });
    expect([...a.res.events, ...b.res.events]).toEqual(first.res.events);
  });
  it("a position is not examined on the tick it opened, only after", async () => {
    // opened exactly on a tick with a stop loss already on the wrong side: it must not close on that same tick
    const t = Math.ceil(T0 / G) * G;
    const p = pos("p4", "qXAUUSD", "BUY", "0.01", t, { slPrice: bid("qXAUUSD", t).add(1) });
    const { res } = await run({ account: account(), positions: [p], fromMs: t - 1, toMs: t + 3 * G });
    expect(res.events[0]?.atMs).toBe(t + G);
  });
  it("two positions are closed in the order the path touched them, whatever the order they were listed in", async () => {
    const a = pos("a", "qXAUUSD", "BUY", "0.05", T0);
    const b = pos("b", "qBTCUSD", "SELL", "0.05", T0);
    const ka = firstTick("qXAUUSD", T0, 6 * 3600 * 4, (bb) => bb.lte(a.openPrice.sub(6)));
    const kb = firstTick("qBTCUSD", T0, 6 * 3600 * 4, (_x, aa) => aa.gte(b.openPrice.add(150)));
    expect(ka).not.toBeNull();
    expect(kb).not.toBeNull();
    const { res } = await run({ account: account({ balance: D(100000) }), positions: [{ ...b, slPrice: b.openPrice.add(150) }, { ...a, slPrice: a.openPrice.sub(6) }], fromMs: T0, toMs: T0 + 10 * HOUR });
    const closes = res.events.filter((e) => e.kind === "close");
    expect(closes.map((e) => e.atMs)).toEqual([...closes.map((e) => e.atMs)].sort((x, y) => x - y));
    expect(closes.map((e) => (e as { positionId: string }).positionId)).toEqual(ka! <= kb! ? ["a", "b"] : ["b", "a"]);
  });
});

describe("demo sweep: stop-out", () => {
  it("closes the position with the largest loss first when the margin level reaches the stop-out level, at that tick", async () => {
    // 2 lots of gold on 10,000: margin about 8,900, level 112%; stop-out 50% = equity 4,450 -> a $28 fall
    const p = pos("big", "qXAUUSD", "BUY", "2", T0);
    const small = pos("small", "qEURUSD", "BUY", "0.1", T0);
    const o = await oracle({ account: account(), positions: [p, small], orders: [], fromMs: T0, toMs: T0 + 3 * 24 * HOUR });
    const so = o.events.find((e) => e.kind === "close" && e.reason === "stop_out");
    expect(so).toBeTruthy(); // the scenario really stops out within three days on this path
    const { res } = await run({ account: account(), positions: [p, small], fromMs: T0, toMs: T0 + 3 * 24 * HOUR });
    expect(res.events).toEqual(o.events);
    expect((res.events[0] as { positionId: string }).positionId).toBe("big"); // the biggest loser goes first
  }, 120_000);
  it("an account that is never in danger is not touched", async () => {
    const { res } = await run({ account: account({ balance: D(1_000_000) }), positions: [pos("safe", "qXAUUSD", "BUY", "0.01", T0)], fromMs: T0, toMs: T0 + 7 * 24 * HOUR });
    expect(res.events).toEqual([]);
  });
});

describe("demo sweep: pending orders", () => {
  it("a BUY LIMIT fills on the first tick whose ask reaches the entry, at that ask, then its stop loss works", async () => {
    const start = tickAtOrAfter(T0);
    const entry = ask("qXAUUSD", start).sub(5);
    const k = firstTick("qXAUUSD", T0, 10 * 3600 * 4, (_b, a) => a.lte(entry));
    expect(k).not.toBeNull();
    const sl = entry.sub(3);
    const order: SimOrder = { id: "o1", side: "BUY", type: "LIMIT", volume: D("0.10"), entry, slPrice: sl, tpPrice: null, symbol: "qXAUUSD", createdMs: T0 };
    const { res } = await run({ account: account(), positions: [], orders: [order], fromMs: T0, toMs: T0 + 24 * HOUR });
    const fill = res.events[0];
    expect(fill).toMatchObject({ kind: "fill", atMs: k, orderId: "o1", price: ask("qXAUUSD", k!).toString() });
    const kStop = firstTick("qXAUUSD", k!, 20 * 3600 * 4, (b) => b.lte(sl));
    if (kStop != null && kStop <= T0 + 24 * HOUR) expect(res.events[1]).toMatchObject({ kind: "close", reason: "stop_loss", atMs: kStop });
  });
  it("a SELL STOP fills when the bid falls to the entry", async () => {
    const entry = bid("qBTCUSD", T0).sub(300);
    const k = firstTick("qBTCUSD", T0, 20 * 3600 * 4, (b) => b.lte(entry));
    expect(k).not.toBeNull();
    const order: SimOrder = { id: "o2", side: "SELL", type: "STOP", volume: D("0.01"), entry, slPrice: null, tpPrice: null, symbol: "qBTCUSD", createdMs: T0 };
    const { res } = await run({ account: account(), positions: [], orders: [order], fromMs: T0, toMs: T0 + 48 * HOUR });
    expect(res.events[0]).toMatchObject({ kind: "fill", atMs: k, price: bid("qBTCUSD", k!).toString() });
  });
  it("an order that would not be affordable at the trigger is rejected, once", async () => {
    const entry = ask("qXAUUSD", T0).sub(5);
    const order: SimOrder = { id: "o3", side: "BUY", type: "LIMIT", volume: D("50"), entry, slPrice: null, tpPrice: null, symbol: "qXAUUSD", createdMs: T0 };
    const { res } = await run({ account: account(), positions: [], orders: [order], fromMs: T0, toMs: T0 + 24 * HOUR });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ kind: "reject", orderId: "o3", reason: "INSUFFICIENT_MARGIN" });
    expect(res.orders).toEqual([]);
  });
  it("an order placed later in the window is not triggered before it existed", async () => {
    const created = T0 + 2 * HOUR;
    const entry = ask("qXAUUSD", created).sub(2);
    const order: SimOrder = { id: "o4", side: "BUY", type: "LIMIT", volume: D("0.01"), entry, slPrice: null, tpPrice: null, symbol: "qXAUUSD", createdMs: created };
    const { res } = await run({ account: account(), positions: [], orders: [order], fromMs: T0, toMs: T0 + 12 * HOUR });
    const fill = res.events.find((e) => e.kind === "fill");
    if (fill) expect(fill.atMs).toBeGreaterThan(created);
  });
});

describe("demo sweep: the jumping walk equals the tick-by-tick oracle", () => {
  // small seeded PRNG so the scenarios are fixed
  const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  it("random books of positions and resting orders over several hours", async () => {
    const rand = rng(20261012);
    let events = 0;
    for (let scenario = 0; scenario < 24; scenario++) {
      const start = T0 + scenario * 5 * HOUR + Math.floor(rand() * 90_000);
      const positions: SimPos[] = [];
      const orders: SimOrder[] = [];
      const nPos = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < nPos; i++) {
        const def = DEMO_SYMBOLS[Math.floor(rand() * DEMO_SYMBOLS.length)];
        const side = rand() < 0.5 ? "BUY" : "SELL";
        const opened = start + Math.floor(rand() * 40 * 60_000);
        const base = pos(`s${scenario}p${i}`, def.name, side, ["0.01", "0.05", "0.5", "1"][Math.floor(rand() * 4)], opened);
        const dist = def.base * (0.0002 + rand() * 0.003);
        const slp = rand() < 0.7 ? D(side === "BUY" ? base.openPrice.toNumber() - dist : base.openPrice.toNumber() + dist).toDecimalPlaces(def.digits) : null;
        const tpp = rand() < 0.6 ? D(side === "BUY" ? base.openPrice.toNumber() + dist * 1.3 : base.openPrice.toNumber() - dist * 1.3).toDecimalPlaces(def.digits) : null;
        positions.push({ ...base, slPrice: slp, tpPrice: tpp });
      }
      if (rand() < 0.7) {
        const def = DEMO_SYMBOLS[Math.floor(rand() * DEMO_SYMBOLS.length)];
        const side = rand() < 0.5 ? "BUY" : "SELL";
        const type = rand() < 0.5 ? "LIMIT" : "STOP";
        const created = start + Math.floor(rand() * 30 * 60_000);
        const q = demoQuoteAt(def.name, created)!;
        const dist = def.base * (0.0003 + rand() * 0.004);
        const refPx = side === "BUY" ? Number(q.ask) : Number(q.bid);
        const below = (side === "BUY") === (type === "LIMIT");
        orders.push({ id: `s${scenario}o`, side, type, volume: D("0.05"), entry: D(below ? refPx - dist : refPx + dist).toDecimalPlaces(def.digits), slPrice: null, tpPrice: null, symbol: def.name, createdMs: created });
      }
      const acct = account({ balance: D([2000, 5000, 20000][Math.floor(rand() * 3)]), leverage: [50, 100, 500][Math.floor(rand() * 3)] });
      const to = start + 2 * HOUR;
      const want = await oracle({ account: acct, positions, orders, fromMs: start - 1, toMs: to });
      const { res, balance } = await run({ account: acct, positions, orders, fromMs: start - 1, toMs: to });
      expect(res.events, `scenario ${scenario}`).toEqual(want.events);
      expect(balance.toString(), `scenario ${scenario} balance`).toBe(want.balance.toString());
      expect(res.positions.map((p) => p.id).sort(), `scenario ${scenario} left open`).toEqual(want.positions.map((p) => p.id).sort());
      events += want.events.length;
    }
    expect(events).toBeGreaterThan(12); // the scenarios are not all empty
  }, 240_000);
  it("is fast: a week-long window with distant levels needs only a handful of evaluations", async () => {
    const p = pos("far", "qXAUUSD", "BUY", "0.1", T0, { slPrice: D("3800"), tpPrice: D("5200") });
    const { res } = await run({ account: account(), positions: [p], fromMs: T0, toMs: T0 + 7 * 24 * HOUR });
    expect(res.events).toEqual([]);
    expect(res.evals).toBeLessThan(5000);
  });
});
