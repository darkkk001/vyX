import "server-only";
import { Prisma } from "@prisma/client";
import { DEMO_GRID_MS, demoDef, demoMaxDeviation, demoPointSize, demoQuoteAt, demoSlopePerSec, type DemoQuote } from "@/lib/demo-prices";
import { closePriceFor, computeRealizedPnl } from "@/lib/trading";
import { checkPreTradeMargin, hedgedUsedMargin, liveUsedMarginFor, type MarginLeg } from "@/lib/margin";

// The QoreTrader demo has no background worker. Everything a live system's risk monitor would have done while the trader was
// away -- a stop loss or take profit touched, a pending order reached, a stop-out -- is replayed here, on request, from the
// deterministic price path (lib/demo-prices.ts) between the last time the account was looked at and now.
//
// The replay walks the 250 ms tick grid (the same ticks the browser draws). It does not visit every tick: the price cannot
// move faster than demoSlopePerSec, so when the nearest trigger is `gap` points away it cannot be reached sooner than
// gap / (largest move per tick) ticks, and the walk jumps straight there. No touch is ever skipped (the property test in
// lib/demo-sweep.test.ts compares this walk with a tick-by-tick oracle). Conventions follow the live monitor
// (lib/risk-monitor.ts): a position closes at the market side of the tick that crossed its level (bid for a BUY, ask for a
// SELL), SL / TP first, then stop-out (the largest loss first, re-measured after each close, at or below the level).
// Time and ordering: events are applied in tick order; within a tick pending fills, then SL/TP (oldest position first), then
// stop-out. A position opened at time T is first examined on the tick after T.
//
// Money always goes through the injected ports (the real ones call closePositionInTx), so the ledger rows are exactly the
// live ones. The notes carry "(demo)" and do not start with the live monitor's "(automatic)" texts: the engine's shadow
// reconciler pairs web closes with those exact texts (engine/order-management/src/reconcile.rs) and must never see a demo.

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ONE = D(1);

export type SimPos = {
  id: string;
  side: "BUY" | "SELL";
  volume: Prisma.Decimal;
  openPrice: Prisma.Decimal;
  slPrice: Prisma.Decimal | null;
  tpPrice: Prisma.Decimal | null;
  symbol: string; // the q-name
  contractSize: Prisma.Decimal;
  quoteCurrency: string;
  openedMs: number;
  hedgedMarginPct: Prisma.Decimal;
};

export type SimOrder = {
  id: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "STOP";
  volume: Prisma.Decimal;
  entry: Prisma.Decimal;
  slPrice: Prisma.Decimal | null;
  tpPrice: Prisma.Decimal | null;
  symbol: string;
  createdMs: number;
};

export type SimAccount = {
  balance: Prisma.Decimal;
  credit: Prisma.Decimal;
  leverage: number;
  stopOutLevel: Prisma.Decimal;
  marginCallLevel: Prisma.Decimal;
};

export type SweepRules = { hedgingAllowed: boolean; maxOpenPositions: number | null };

export type SweepPorts = {
  /** Book the close at the given time. `closed: false` = somebody else closed it first. balance/credit = the account after. */
  closePosition(p: SimPos, closePrice: Prisma.Decimal, atMs: number, note: string): Promise<{ closed: boolean; balance: Prisma.Decimal; credit: Prisma.Decimal }>;
  /** Fill the pending order at the given time and price; null = it was no longer pending. */
  fillPending(o: SimOrder, fillPrice: Prisma.Decimal, atMs: number): Promise<SimPos | null>;
  rejectPending(o: SimOrder, reason: string, atMs: number): Promise<void>;
};

export type SweepEvent =
  | { kind: "close"; atMs: number; positionId: string; reason: "stop_loss" | "take_profit" | "stop_out"; price: string }
  | { kind: "fill"; atMs: number; orderId: string; positionId: string; price: string }
  | { kind: "reject"; atMs: number; orderId: string; reason: string };

export type SweepLimits = { maxEvals: number; deadlineAtMs: number };
export const DEFAULT_SWEEP_LIMITS = (): SweepLimits => ({ maxEvals: 400_000, deadlineAtMs: Date.now() + 2500 });

export type SweepResult = {
  /** everything up to this time has been replayed */
  reachedMs: number;
  events: SweepEvent[];
  positions: SimPos[];
  orders: SimOrder[];
  account: SimAccount;
  complete: boolean;
  evals: number;
};

const G = DEMO_GRID_MS;
const firstTickAfter = (ms: number) => Math.floor(ms / G) + 1;

type SymInfo = { pt: number; pow: number; lipPts: number; maxPriceMovePerTick: number; rateBound: number };
const symInfoCache = new Map<string, SymInfo>();
function symInfo(name: string): SymInfo {
  let s = symInfoCache.get(name);
  if (s) return s;
  const d = demoDef(name);
  if (!d) throw new Error(`not a demo symbol: ${name}`);
  const pt = demoPointSize(name);
  const lipPts = Math.ceil((demoSlopePerSec(name) * (G / 1000)) / pt) + 2; // + the rounding of the mid to a point at both ends
  const pmin = d.base * (1 - demoMaxDeviation(name));
  s = { pt, pow: Math.round(1 / pt), lipPts, maxPriceMovePerTick: lipPts * pt, rateBound: d.quoteCurrency === "USD" ? 1 : 1.3 / pmin };
  symInfoCache.set(name, s);
  return s;
}

type TickQuotes = { t: number; get(name: string): DemoQuote };
function quotesAt(t: number): TickQuotes {
  const m = new Map<string, DemoQuote>();
  return {
    t,
    get(name) {
      let q = m.get(name);
      if (!q) {
        q = demoQuoteAt(name, t)!;
        m.set(name, q);
      }
      return q;
    },
  };
}

/** quote currency -> USD at this tick (the demo's accounts are USD): 1 for USD, 1 / mid(USDJPY) for the "QJP" quote. */
function rateOf(quoteCurrency: string, q: TickQuotes): Prisma.Decimal | null {
  if (quoteCurrency === "USD") return ONE;
  if (quoteCurrency === "QJP") {
    const j = q.get("qUSDJPY");
    const mid = D(j.bid).add(D(j.ask)).div(2);
    return mid.gt(0) ? ONE.div(mid) : null;
  }
  return null;
}

type Measure = { equity: Prisma.Decimal; used: Prisma.Decimal; level: Prisma.Decimal | null; worst: { pos: SimPos; pnl: Prisma.Decimal; closePrice: Prisma.Decimal } | null };
function measure(acct: SimAccount, positions: SimPos[], q: TickQuotes): Measure {
  let equity = acct.balance.add(acct.credit);
  const legs: MarginLeg[] = [];
  let worst: Measure["worst"] = null;
  for (const p of positions) {
    const rate = rateOf(p.quoteCurrency, q);
    if (!rate) continue; // unpriced: counted nowhere, like the live monitor
    const qt = q.get(p.symbol);
    const bid = D(qt.bid);
    const ask = D(qt.ask);
    const cp = closePriceFor(p.side, bid, ask);
    const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.contractSize }).mul(rate);
    equity = equity.add(pnl);
    legs.push({ symbolKey: p.symbol, side: p.side, volume: p.volume, margin: liveUsedMarginFor({ side: p.side, volume: p.volume, contractSize: p.contractSize, bid, ask, leverage: acct.leverage }).mul(rate), hedgedMarginPct: p.hedgedMarginPct });
    if (!worst || pnl.lt(worst.pnl)) worst = { pos: p, pnl, closePrice: cp };
  }
  const used = hedgedUsedMargin(legs);
  return { equity, used, level: used.gt(0) ? equity.div(used).mul(100) : null, worst };
}

/** Double-precision estimate of the stop-out slack S = equity - stopOut% * usedMargin (plain, un-hedged margin: never larger than the truth's margin). */
function slackEstimate(acct: SimAccount, positions: SimPos[], q: TickQuotes): { s: number; scale: number; deltaPerTick: number } {
  const so = acct.stopOutLevel.toNumber() / 100;
  let equity = acct.balance.add(acct.credit).toNumber();
  let used = 0;
  let delta = 0;
  for (const p of positions) {
    const info = symInfo(p.symbol);
    const jpy = symInfo("qUSDJPY");
    const rate = p.quoteCurrency === "USD" ? 1 : p.quoteCurrency === "QJP" ? 2 / (q.get("qUSDJPY").bidPts / jpy.pow + q.get("qUSDJPY").askPts / jpy.pow) : NaN;
    if (!Number.isFinite(rate)) continue;
    const qt = q.get(p.symbol);
    const cp = (p.side === "BUY" ? qt.bidPts : qt.askPts) / info.pow;
    const units = p.volume.toNumber() * p.contractSize.toNumber();
    equity += (p.side === "BUY" ? cp - p.openPrice.toNumber() : p.openPrice.toNumber() - cp) * units * rate;
    used += (units * cp * rate) / acct.leverage;
    delta += units * info.rateBound * info.maxPriceMovePerTick * (1 + so / acct.leverage);
  }
  return { s: equity - so * used, scale: Math.abs(equity) + used, deltaPerTick: delta * 1.05 };
}

export async function simulateSweep(input: {
  account: SimAccount;
  positions: SimPos[];
  orders: SimOrder[];
  rules: SweepRules;
  fromMs: number;
  toMs: number;
  ports: SweepPorts;
  limits?: SweepLimits;
}): Promise<SweepResult> {
  const { ports, rules } = input;
  const limits = input.limits ?? DEFAULT_SWEEP_LIMITS();
  const acct: SimAccount = { ...input.account };
  let positions = [...input.positions].sort((a, b) => a.openedMs - b.openedMs || (a.id < b.id ? -1 : 1));
  let orders = [...input.orders].sort((a, b) => a.createdMs - b.createdMs || (a.id < b.id ? -1 : 1));
  const events: SweepEvent[] = [];
  const lastTick = Math.floor(input.toMs / G);
  let evals = 0;

  const startTickOf = (ms: number) => firstTickAfter(ms);
  let tick = Math.max(firstTickAfter(input.fromMs), 0);
  // jump to the first moment anything exists
  const earliest = () => Math.min(...positions.map((p) => startTickOf(p.openedMs)), ...orders.map((o) => startTickOf(o.createdMs)));
  if (positions.length + orders.length === 0) return { reachedMs: input.toMs, events, positions, orders, account: acct, complete: true, evals };
  tick = Math.max(tick, earliest());

  const sl = (p: SimPos, pow: number) => (p.slPrice ? p.slPrice.mul(pow).toNumber() : null);
  const tp = (p: SimPos, pow: number) => (p.tpPrice ? p.tpPrice.mul(pow).toNumber() : null);

  while (tick <= lastTick) {
    if (positions.length + orders.length === 0) break;
    if (evals >= limits.maxEvals || (evals % 256 === 255 && Date.now() > limits.deadlineAtMs)) {
      return { reachedMs: (tick - 1) * G, events, positions, orders, account: acct, complete: false, evals };
    }
    evals++;
    const tMs = tick * G;
    const q = quotesAt(tMs);

    // ---- 1. pending orders that have reached their entry ----
    for (const o of [...orders]) {
      if (startTickOf(o.createdMs) > tick) continue;
      const info = symInfo(o.symbol);
      const qt = q.get(o.symbol);
      const entryPts = o.entry.mul(info.pow).toNumber();
      const hit =
        o.side === "BUY" ? (o.type === "LIMIT" ? qt.askPts <= entryPts : qt.askPts >= entryPts) : o.type === "LIMIT" ? qt.bidPts >= entryPts : qt.bidPts <= entryPts;
      if (!hit) continue;
      const fill = D(o.side === "BUY" ? qt.ask : qt.bid);
      const reject = async (reason: string) => {
        orders = orders.filter((x) => x.id !== o.id);
        await ports.rejectPending(o, reason, tMs);
        events.push({ kind: "reject", atMs: tMs, orderId: o.id, reason });
      };
      if (!rules.hedgingAllowed && positions.some((p) => p.symbol === o.symbol && p.side !== o.side)) {
        await reject("hedging is not allowed on this account");
        continue;
      }
      if (rules.maxOpenPositions != null && positions.length >= rules.maxOpenPositions) {
        await reject("the maximum number of open positions is reached");
        continue;
      }
      const m = measure(acct, positions.filter((p) => p.openedMs <= tMs), q);
      const rate = rateOf(demoDef(o.symbol)!.quoteCurrency, q);
      const required = rate ? o.volume.mul(demoDef(o.symbol)!.contractSize).mul(fill).div(acct.leverage).mul(rate) : null;
      if (!required || checkPreTradeMargin({ equity: m.equity, usedMargin: m.used, requiredMargin: required, marginCallLevel: acct.marginCallLevel })) {
        await reject("INSUFFICIENT_MARGIN");
        continue;
      }
      const opened = await ports.fillPending(o, fill, tMs);
      orders = orders.filter((x) => x.id !== o.id);
      if (opened) {
        positions.push(opened);
        positions.sort((a, b) => a.openedMs - b.openedMs || (a.id < b.id ? -1 : 1));
        events.push({ kind: "fill", atMs: tMs, orderId: o.id, positionId: opened.id, price: fill.toString() });
      }
    }

    // ---- 2. stop loss / take profit, oldest position first ----
    for (const p of [...positions]) {
      if (startTickOf(p.openedMs) > tick) continue; // opened at or after this tick: first examined on the next one
      const info = symInfo(p.symbol);
      const qt = q.get(p.symbol);
      const cpPts = p.side === "BUY" ? qt.bidPts : qt.askPts;
      const slPts = sl(p, info.pow);
      const tpPts = tp(p, info.pow);
      let reason: "stop_loss" | "take_profit" | null = null;
      if (p.side === "BUY") {
        if (slPts != null && cpPts <= slPts) reason = "stop_loss";
        else if (tpPts != null && cpPts >= tpPts) reason = "take_profit";
      } else {
        if (slPts != null && cpPts >= slPts) reason = "stop_loss";
        else if (tpPts != null && cpPts <= tpPts) reason = "take_profit";
      }
      if (!reason) continue;
      const price = D(p.side === "BUY" ? qt.bid : qt.ask);
      const r = await ports.closePosition(p, price, tMs, reason === "stop_loss" ? "Stop loss hit (demo)" : "Take profit hit (demo)");
      positions = positions.filter((x) => x.id !== p.id);
      acct.balance = r.balance;
      acct.credit = r.credit;
      if (r.closed) events.push({ kind: "close", atMs: tMs, positionId: p.id, reason, price: price.toString() });
    }

    // ---- 3. stop-out ----
    const openNow = () => positions.filter((p) => p.openedMs <= tMs);
    if (openNow().length > 0) {
      const est = slackEstimate(acct, openNow(), q);
      if (est.s <= 1e-6 * est.scale + 1e-6) {
        for (;;) {
          const m = measure(acct, openNow(), q);
          if (m.level == null || m.level.gt(acct.stopOutLevel) || !m.worst) break;
          const w = m.worst;
          const r = await ports.closePosition(w.pos, w.closePrice, tMs, `Stop-out (demo): margin level ${m.level.toFixed(2)}% at or below ${acct.stopOutLevel.toString()}%`);
          positions = positions.filter((x) => x.id !== w.pos.id);
          acct.balance = r.balance;
          acct.credit = r.credit;
          if (r.closed) events.push({ kind: "close", atMs: tMs, positionId: w.pos.id, reason: "stop_out", price: w.closePrice.toString() });
          if (openNow().length === 0) break;
        }
      }
    }

    // ---- 4. how far can we jump? ----
    let step = Infinity;
    let nextStart = Infinity;
    for (const p of positions) {
      const st = startTickOf(p.openedMs);
      if (st > tick) {
        nextStart = Math.min(nextStart, st);
        continue;
      }
      const info = symInfo(p.symbol);
      const qt = q.get(p.symbol);
      const cpPts = p.side === "BUY" ? qt.bidPts : qt.askPts;
      const slPts = sl(p, info.pow);
      const tpPts = tp(p, info.pow);
      const gaps: number[] = [];
      if (p.side === "BUY") {
        if (slPts != null) gaps.push(cpPts - slPts);
        if (tpPts != null) gaps.push(tpPts - cpPts);
      } else {
        if (slPts != null) gaps.push(slPts - cpPts);
        if (tpPts != null) gaps.push(cpPts - tpPts);
      }
      for (const gap of gaps) step = Math.min(step, Math.max(1, Math.ceil(gap / info.lipPts)));
    }
    for (const o of orders) {
      const st = startTickOf(o.createdMs);
      if (st > tick) {
        nextStart = Math.min(nextStart, st);
        continue;
      }
      const info = symInfo(o.symbol);
      const qt = q.get(o.symbol);
      const entryPts = o.entry.mul(info.pow).toNumber();
      const gap = o.side === "BUY" ? (o.type === "LIMIT" ? qt.askPts - entryPts : entryPts - qt.askPts) : o.type === "LIMIT" ? entryPts - qt.bidPts : qt.bidPts - entryPts;
      step = Math.min(step, Math.max(1, Math.ceil(gap / info.lipPts)));
    }
    const active = openNow();
    if (active.length > 0) {
      const est = slackEstimate(acct, active, q);
      if (est.deltaPerTick > 0) step = Math.min(step, Math.max(1, est.s > 0 ? Math.ceil(est.s / est.deltaPerTick) : 1));
    }
    let next = Number.isFinite(step) ? tick + step : Infinity;
    if (nextStart !== Infinity) next = Math.min(next, nextStart);
    if (next === Infinity) break; // nothing can ever trigger (no levels, no margin to lose)
    tick = Math.max(next, tick + 1);
  }

  return { reachedMs: input.toMs, events, positions, orders, account: acct, complete: true, evals };
}
