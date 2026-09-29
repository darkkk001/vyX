// RUNNER: executes one scenario's steps in order, the price driver and the trade driver working together:
//   price.set / price.jump / rampUntil  move a synthetic symbol (rampUntil watches a condition while it ramps);
//   open / close / closeAccount         trade through the web trade API at the server's own quote;
//   hold / observe / expect             wait, log the bot's margin estimate, and check what the SERVER did.
// Always, at the end (also after a failure): flatten the scenario's accounts, stop ticking its symbols, then SETTLE
// (owner, 2026-09-29): wait settleSecs (default 90) so the shadow's 4 s pass and 60 s reconciler record this
// scenario's risk events before the next scenario's activity starts -- journaled, so shadow_pair rows are
// attributable. At most maxOpenAccounts accounts hold open positions at any moment (Neon load).
import type { Journal } from "./journal";
import type { PriceDriver } from "./price-driver";
import { sleep } from "./price-driver";
import type { Pos, Side, TradeBackend } from "./trade-client";
import { assertAccount, assertSymbol } from "./guards";
import type { Observer } from "./observer";
import { estimate, lotsForMarginPct, lotsForStopOutAt, type SymbolMeta } from "./margin";

type Common = { liveOnly?: boolean };
export type Step = Common & (
  | { op: "note"; text: string }
  | { op: "price.set"; symbol: string; bid: number; spread: number }
  | { op: "price.jump"; symbol: string; pct: number }
  | { op: "open"; account: string; symbol: string; side: Side; volume?: number; marginPctOfEquity?: number; stopOutAtPct?: number; volumeOf?: string; as: string }
  | { op: "require"; account: string; minEquity: number }
  | { op: "close"; ref: string }
  | { op: "closeAccount"; account: string }
  | { op: "rampUntil"; symbol: string; direction: "up" | "down"; pctPerSec: number; maxPct: number; timeoutSecs: number; until: Until }
  | { op: "hold"; secs: number; expectOpen?: string[] }
  | { op: "observe"; account: string }
  | { op: "closeBy"; ref: string; against: string }
  | { op: "coverageBaseline" }
  | { op: "expectCoverageLeg"; ref: string; timeoutSecs: number }
  | { op: "expectCoverageClosed"; ref: string; timeoutSecs: number }
  | { op: "expect"; stoppedOut?: string[]; nbpWriteOff?: string; stillOpen?: string[] }
  | { op: "ramp"; symbol: string; direction: "up" | "down"; pctPerSec: number; pct: number }
  | { op: "waitUntil"; until: Until; timeoutSecs: number }
  | { op: "expectMirror"; sourceRef: string; targetAccount: string; factor: number; reversed: boolean; timeoutSecs: number; as: string }
  | { op: "expectNoNewPosition"; account: string; symbol: string; secs: number }
);
export type Until = { closed: string[] } | { marginLevelAtOrBelow: { account: string; level: number } };
export type Scenario = { name: string; title: string; accounts: string[]; symbols: string[]; allowJump?: boolean; needsObserver?: boolean; steps: Step[] };
export type RunnerOpts = { maxOpenAccounts: number; settleSecs: number; pollMs: number; dryRun: boolean; meta: Record<string, SymbolMeta>; fx: (q: string, a: string) => number; observer?: Observer };

export class ScenarioFailed extends Error {}

export class Runner {
  private readonly refs = new Map<string, { account: string; positionId: string; symbol: string; side: Side; volume: number }>();
  private readonly closedByBot = new Set<string>();
  /** the coverage account's positions before the scenario's order, and each client ref's leg found there */
  private coverageBefore = new Set<string>();
  private readonly legOf = new Map<string, string>();
  private startedAt = new Date().toISOString();
  constructor(private readonly trade: TradeBackend, private readonly price: PriceDriver, private readonly journal: Journal, private readonly opts: RunnerOpts) {}

  async run(sc: Scenario): Promise<boolean> {
    for (const a of sc.accounts) assertAccount(a);
    for (const s of sc.symbols) assertSymbol(s);
    this.startedAt = new Date().toISOString();
    this.journal.write({ kind: "scenario.start", scenario: sc.name, title: sc.title, accounts: sc.accounts, symbols: sc.symbols, dryRun: this.opts.dryRun });
    let ok = true;
    try {
      for (const [i, step] of sc.steps.entries()) {
        this.journal.write({ kind: "step", scenario: sc.name, n: i + 1, op: step.op, ...stepArgs(step) });
        if (step.liveOnly && this.opts.dryRun) { this.journal.write({ kind: "step.skipped", n: i + 1, why: "live only: the dry-run simulator does not model markups / commissions / the server's write-off" }); continue; }
        await this.exec(sc, step);
      }
    } catch (e) {
      ok = false;
      this.journal.write({ kind: "scenario.failed", scenario: sc.name, error: (e as Error).message });
    } finally {
      await this.flatten(sc);
      this.price.release(sc.symbols);
      this.journal.write({ kind: "settle.start", scenario: sc.name, secs: this.opts.settleSecs, why: "shadow pass 4 s + reconciler 60 s record this scenario before the next one" });
      if (!this.opts.dryRun) await sleep(this.opts.settleSecs * 1000);
      this.journal.write({ kind: "settle.end", scenario: sc.name, waited: this.opts.dryRun ? 0 : this.opts.settleSecs });
      this.journal.write({ kind: "scenario.end", scenario: sc.name, result: ok ? "PASS" : "FAIL" });
    }
    return ok;
  }

  private async exec(sc: Scenario, step: Step): Promise<void> {
    switch (step.op) {
      case "note": return;
      case "price.set": return this.price.set(step.symbol, step.bid, step.spread);
      case "price.jump":
        if (!sc.allowJump) throw new ScenarioFailed("price.jump is only allowed in scenarios that set allowJump");
        return this.price.jump(step.symbol, step.pct);
      case "open": return this.open(sc, step);
      case "close": {
        const r = this.ref(step.ref); const q = await this.trade.quote(r.account, r.symbol);
        const res = await this.trade.close(r.account, r.positionId, r.side === "BUY" ? q.bid : q.ask);
        this.journal.write({ kind: "close", ref: step.ref, account: r.account, positionId: r.positionId, status: res.status, error: res.error });
        if (res.status !== 200) throw new ScenarioFailed(`close ${step.ref} answered ${res.status}: ${res.error}`);
        this.closedByBot.add(r.positionId); return;
      }
      case "closeAccount": return this.closeAll(step.account);
      case "closeBy": {
        // a hedged pair closed against each other in one request: closing one leg first would leave the other alone
        // (full margin) on an account whose equity may be negative, and the stop-out would take it before the second close
        const a = this.ref(step.ref), b = this.ref(step.against);
        if (a.account !== b.account) throw new ScenarioFailed(`closeBy ${step.ref} / ${step.against}: different accounts`);
        const res = await this.trade.closeBy(a.account, a.positionId, b.positionId);
        this.journal.write({ kind: "closeBy", ref: step.ref, against: step.against, account: a.account, positionIds: [a.positionId, b.positionId], status: res.status, error: res.error });
        if (res.status !== 200) throw new ScenarioFailed(`closeBy ${step.ref} / ${step.against} answered ${res.status}: ${res.error}${res.status === 202 ? " (queued for a dealer, not closed)" : ""}`);
        this.closedByBot.add(a.positionId); this.closedByBot.add(b.positionId); return;
      }
      case "rampUntil": {
        const why = await this.price.ramp(step.symbol, step.direction, step.pctPerSec, step.maxPct, step.timeoutSecs, () => this.met(step.until));
        if (why !== "condition") throw new ScenarioFailed(`rampUntil ${JSON.stringify(step.until)} not met (${why})`);
        return;
      }
      case "hold": {
        const end = Date.now() + step.secs * 1000;
        while (Date.now() < end) {
          for (const ref of step.expectOpen ?? []) {
            const r = this.ref(ref);
            if (!(await this.trade.positions(r.account)).some((p) => p.id === r.positionId)) throw new ScenarioFailed(`${ref} was closed during the hold (expected to stay open)`);
          }
          await sleep(Math.max(this.opts.pollMs, 1000));
        }
        return;
      }
      case "observe": { await this.observe(step.account); return; }
      case "require": {
        // fail up front (before any order) when an earlier scenario left the account too low for this one
        const e = await this.observe(step.account, true);
        this.journal.write({ kind: "require", account: step.account, equity: e.equity, minEquity: step.minEquity });
        if (e.equity < step.minEquity) throw new ScenarioFailed(`${step.account} equity ${e.equity} is below ${step.minEquity}: reset the tenant's balances (scripts/seed-zzshadowbot.ts --reset-trading) or pick another account`);
        return;
      }
      case "ramp": {
        // a fixed move with no stop condition (e.g. S4, where used margin is 0 and no margin condition can trigger)
        await this.price.ramp(step.symbol, step.direction, step.pctPerSec, step.pct, 3600, async () => false);
        return;
      }
      case "waitUntil": {
        const end = Date.now() + step.timeoutSecs * 1000;
        while (!(await this.met(step.until))) {
          if (Date.now() > end) throw new ScenarioFailed(`waitUntil ${JSON.stringify(step.until)} not met within ${step.timeoutSecs} s`);
          await sleep(Math.max(this.opts.pollMs, 1000));
        }
        this.journal.write({ kind: "waitUntil.met", until: step.until });
        return;
      }
      case "expectMirror": return this.expectMirror(step);
      case "expectNoNewPosition": {
        const before = new Set((await this.trade.positions(step.account)).map((p) => p.id));
        const end = Date.now() + step.secs * 1000;
        while (Date.now() < end) {
          const extra = (await this.trade.positions(step.account)).filter((p) => p.symbol === step.symbol && !before.has(p.id));
          if (extra.length) throw new ScenarioFailed(`${step.account} got new ${step.symbol} position(s) ${extra.map((p) => p.id).join(", ")} (expected none: the rule should be stopped)`);
          await sleep(Math.max(this.opts.pollMs, 1000));
        }
        this.journal.write({ kind: "noNewPosition.confirmed", account: step.account, symbol: step.symbol, secs: step.secs });
        return;
      }
      case "expect": return this.expect(step);
      case "coverageBaseline": {
        const ps = await this.observer().coveragePositions();
        this.coverageBefore = new Set(ps.map((p) => p.id));
        this.journal.write({ kind: "coverage.baseline", open: ps.length });
        return;
      }
      case "expectCoverageLeg": return this.expectCoverageLeg(step);
      case "expectCoverageClosed": return this.expectCoverageClosed(step);
    }
  }

  private async open(sc: Scenario, s: Extract<Step, { op: "open" }>): Promise<void> {
    if (!sc.accounts.includes(s.account)) throw new ScenarioFailed(`account ${s.account} is not in the scenario's account list`);
    const busy = new Set<string>();
    for (const a of sc.accounts) if ((await this.trade.positions(a)).length > 0) busy.add(a);
    busy.add(s.account);
    if (busy.size > this.opts.maxOpenAccounts) throw new ScenarioFailed(`opening on ${s.account} would put ${busy.size} accounts in open positions (max ${this.opts.maxOpenAccounts})`);
    const me = await this.trade.me(s.account);
    const q = await this.trade.quote(s.account, s.symbol);
    const price = s.side === "BUY" ? q.ask : q.bid;
    let volume = s.volume ?? 0;
    if (s.marginPctOfEquity != null) {
      const e = estimate(me, await this.trade.positions(s.account), { [s.symbol]: q }, this.opts.meta, this.opts.fx);
      const m = this.opts.meta[s.symbol];
      volume = lotsForMarginPct(s.marginPctOfEquity, e.equity, me.leverage, m.contractSize, (q.bid + q.ask) / 2, this.opts.fx(m.quoteCurrency, me.currency));
    }
    if (s.volumeOf) volume = this.ref(s.volumeOf).volume;   // the other leg of a hedged pair: exactly the same lots
    if (s.stopOutAtPct != null) {
      const e = estimate(me, await this.trade.positions(s.account), { [s.symbol]: q }, this.opts.meta, this.opts.fx);
      const m = this.opts.meta[s.symbol];
      volume = lotsForStopOutAt(s.stopOutAtPct, e.equity, me.leverage, me.stopOutLevel, m.contractSize, (q.bid + q.ask) / 2, this.opts.fx(m.quoteCurrency, me.currency));
      this.journal.write({ kind: "sizing", ref: s.as, stopOutAtPct: s.stopOutAtPct, wipeOutAtPct: Number((s.stopOutAtPct + me.stopOutLevel / me.leverage).toFixed(3)), volume });
    }
    if (!(volume > 0)) throw new ScenarioFailed(`open ${s.as}: no volume (sizing gave ${volume})`);
    const res = await this.trade.market(s.account, s.symbol, s.side, volume, price, "unlimited");
    this.journal.write({ kind: "order", ref: s.as, account: s.account, symbol: s.symbol, side: s.side, volume, quotedPrice: price, status: res.status, orderId: res.orderId, orderStatus: res.orderStatus, positionId: res.positionId, fillPrice: res.fillPrice, idempotencyKey: res.idempotencyKey, error: res.error });
    if (res.status !== 201 || !res.positionId) throw new ScenarioFailed(`open ${s.as} not filled (${res.status} ${res.orderStatus ?? ""} ${res.error ?? ""})`);
    this.refs.set(s.as, { account: s.account, positionId: res.positionId, symbol: s.symbol, side: s.side, volume });
    await this.observe(s.account);
  }

  private async met(u: Until): Promise<boolean> {
    if ("closed" in u) {
      for (const ref of u.closed) {
        const r = this.ref(ref);
        if ((await this.trade.positions(r.account)).some((p) => p.id === r.positionId)) return false;
      }
      return true;
    }
    const e = await this.observe(u.marginLevelAtOrBelow.account, true);
    return e.marginLevel != null && e.marginLevel <= u.marginLevelAtOrBelow.level;
  }

  private async observe(account: string, quiet = false) {
    const me = await this.trade.me(account);
    const ps = await this.trade.positions(account);
    const quotes: Record<string, { bid: number; ask: number }> = {};
    for (const s of new Set(ps.map((p) => p.symbol))) quotes[s] = this.price.quote(s);
    const e = estimate(me, ps, quotes, this.opts.meta, this.opts.fx);
    if (!quiet) this.journal.write({ kind: "observe", account, positions: ps.length, balance: e.balance, equity: e.equity, floating: e.floating, usedMargin: e.usedMargin, marginLevel: e.marginLevel, marginCallLevel: me.marginCallLevel, stopOutLevel: me.stopOutLevel, source: "bot estimate" });
    return e;
  }

  private async expect(s: Extract<Step, { op: "expect" }>): Promise<void> {
    for (const ref of s.stoppedOut ?? []) {
      const r = this.ref(ref);
      if ((await this.trade.positions(r.account)).some((p) => p.id === r.positionId)) throw new ScenarioFailed(`${ref} is still open (expected a stop-out)`);
      if (this.closedByBot.has(r.positionId)) throw new ScenarioFailed(`${ref} was closed by the bot, not by a stop-out`);
      const h = (await this.trade.history(r.account, this.startedAt)).find((c) => c.id === r.positionId);
      const me = await this.trade.me(r.account);
      this.journal.write({ kind: "stopout.inferred", ref, account: r.account, positionId: r.positionId, closePrice: h?.closePrice ?? null, realizedPnl: h?.realizedPnl ?? null, closedAt: h?.closedAt ?? null, stopOutLevel: me.stopOutLevel, balanceAfter: me.balance,
        basis: "closed by the server, not by the bot, no SL/TP set; the authoritative reason is the ledger note / shadow_pair" });
    }
    for (const ref of s.stillOpen ?? []) {
      const r = this.ref(ref);
      if (!(await this.trade.positions(r.account)).some((p) => p.id === r.positionId)) throw new ScenarioFailed(`${ref} is closed (expected open)`);
    }
    if (s.nbpWriteOff) {
      const w = (await this.trade.transactions(s.nbpWriteOff)).filter((t) => t.type === "NEGATIVE_BALANCE_PROTECTION" && t.createdAt >= this.startedAt);
      if (w.length === 0) throw new ScenarioFailed(`no negative-balance write-off on ${s.nbpWriteOff}`);
      this.journal.write({ kind: "nbp.confirmed", account: s.nbpWriteOff, writeOffs: w.map((t) => ({ amount: t.amount, note: t.note, at: t.createdAt })) });
    }
  }

  private observer(): Observer {
    if (!this.opts.observer) throw new ScenarioFailed("this step needs the read-only staff observer");
    return this.opts.observer;
  }

  /** The auto-hedge leg of `ref` on the coverage account: a position that was not there before the order, on the same
   *  symbol, side and volume as the client's (lib/coverage.ts). */
  private async expectCoverageLeg(s: Extract<Step, { op: "expectCoverageLeg" }>): Promise<void> {
    const r = this.ref(s.ref);
    const end = Date.now() + s.timeoutSecs * 1000;
    for (;;) {
      const leg = (await this.observer().coveragePositions()).find((p) => !this.coverageBefore.has(p.id) && ![...this.legOf.values()].includes(p.id) && p.symbol === r.symbol && p.side === r.side && Math.abs(p.volume - r.volume) < 1e-9);
      if (leg) {
        this.legOf.set(s.ref, leg.id);
        this.journal.write({ kind: "coverage.leg", ref: s.ref, clientPositionId: r.positionId, legId: leg.id, ticket: leg.ticket, symbol: leg.symbol, side: leg.side, volume: leg.volume, openPrice: leg.openPrice, openedAt: leg.openedAt });
        return;
      }
      if (Date.now() > end) throw new ScenarioFailed(`no auto-hedge leg for ${s.ref} (${r.side} ${r.volume} ${r.symbol}) on the coverage account within ${s.timeoutSecs} s`);
      await sleep(this.opts.pollMs);
    }
  }

  /** The leg found by expectCoverageLeg is gone from the coverage account (closed with the client position). */
  private async expectCoverageClosed(s: Extract<Step, { op: "expectCoverageClosed" }>): Promise<void> {
    const leg = this.legOf.get(s.ref);
    if (!leg) throw new ScenarioFailed(`expectCoverageClosed ${s.ref}: no leg recorded (expectCoverageLeg first)`);
    const end = Date.now() + s.timeoutSecs * 1000;
    for (;;) {
      if (!(await this.observer().coveragePositions()).some((p) => p.id === leg)) {
        this.journal.write({ kind: "coverage.closed", ref: s.ref, legId: leg });
        return;
      }
      if (Date.now() > end) throw new ScenarioFailed(`the auto-hedge leg ${leg} of ${s.ref} is still open on the coverage account after ${s.timeoutSecs} s`);
      await sleep(this.opts.pollMs);
    }
  }

  /** A copy rule's copy on the target account: same symbol, side reversed (or not), volume = source x factor. */
  private async expectMirror(s: Extract<Step, { op: "expectMirror" }>): Promise<void> {
    assertAccount(s.targetAccount);
    const src = this.ref(s.sourceRef);
    const side: Side = s.reversed ? (src.side === "BUY" ? "SELL" : "BUY") : src.side;
    const want = Number((src.volume * s.factor).toFixed(2));
    const end = Date.now() + s.timeoutSecs * 1000;
    for (;;) {
      const hit = (await this.trade.positions(s.targetAccount)).find((p) => p.symbol === src.symbol && p.side === side && Math.abs(p.volume - want) < 1e-9 && ![...this.refs.values()].some((r) => r.positionId === p.id));
      if (hit) {
        this.refs.set(s.as, { account: s.targetAccount, positionId: hit.id, symbol: hit.symbol, side: hit.side, volume: hit.volume });
        this.journal.write({ kind: "mirror.confirmed", sourceRef: s.sourceRef, sourcePositionId: src.positionId, targetAccount: s.targetAccount, targetPositionId: hit.id, side, volume: hit.volume, openPrice: hit.openPrice });
        return;
      }
      if (Date.now() > end) throw new ScenarioFailed(`no ${side} ${want} ${src.symbol} copy on ${s.targetAccount} within ${s.timeoutSecs} s`);
      await sleep(Math.max(this.opts.pollMs, 1000));
    }
  }

  private async closeAll(account: string): Promise<void> {
    for (const p of await this.trade.positions(account)) await this.closeOne(account, p);
  }
  private async closeOne(account: string, p: Pos): Promise<void> {
    const q = await this.trade.quote(account, p.symbol);
    const res = await this.trade.close(account, p.id, p.side === "BUY" ? q.bid : q.ask);
    this.closedByBot.add(p.id);
    this.journal.write({ kind: "close", account, positionId: p.id, symbol: p.symbol, side: p.side, volume: p.volume, status: res.status, error: res.error, why: "flatten" });
  }
  /** End of every scenario: close whatever the scenario's accounts still hold (the prices are still ticking here). */
  private async flatten(sc: Scenario): Promise<void> {
    for (const a of sc.accounts) {
      try { await this.closeAll(a); } catch (e) { this.journal.write({ kind: "flatten.error", account: a, error: (e as Error).message }); }
    }
    this.journal.write({ kind: "flatten.done", scenario: sc.name });
  }
  private ref(name: string) { const r = this.refs.get(name); if (!r) throw new ScenarioFailed(`unknown position ref ${name}`); return r; }
}

function stepArgs(s: Step): Record<string, unknown> { const { op: _op, ...rest } = s as Record<string, unknown>; void _op; return rest; }
