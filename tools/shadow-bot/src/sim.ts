// DRY RUN backend: no network. Accounts start from the config's seed values, orders fill at the price driver's
// levels (BUY at the ask, SELL at the bid), and every positions() read first runs a simulated stop-out (while the
// margin level is at or below the group's stop-out, close the worst-losing position), like the server's risk pass.
// Not simulated: group spread markups and commissions (the live server applies them), swaps, FX drift.
import type { Closed, Me, OrderResult, Pos, Quote, Side, TradeBackend, Txn } from "./trade-client";
import type { PriceDriver, TickSink, Tick } from "./price-driver";
import { estimate, type SymbolMeta } from "./margin";

export type SimAccount = { currency: string; leverage: number; balance: number; credit: number; marginCallLevel: number; stopOutLevel: number; group: string };

export class RecordingSink implements TickSink {
  count = 0;
  async send(ticks: Tick[]): Promise<void> { this.count += ticks.length; }
}

export class SimTradeBackend implements TradeBackend {
  private readonly accounts = new Map<string, SimAccount>();
  private readonly open = new Map<string, Pos[]>();
  private readonly closed = new Map<string, Closed[]>();
  private readonly txns = new Map<string, Txn[]>();
  private seq = 0;
  constructor(accounts: Record<string, SimAccount>, private readonly price: PriceDriver, private readonly meta: Record<string, SymbolMeta>, private readonly fxRates: Record<string, number>) {
    for (const [n, a] of Object.entries(accounts)) this.accounts.set(n, { ...a });
  }
  private fx = (q: string, a: string): number => {
    const d = (x: string, y: string) => (x === y ? 1 : this.fxRates[`${x}${y}`] ?? (this.fxRates[`${y}${x}`] ? 1 / this.fxRates[`${y}${x}`] : NaN));
    const v = d(q, a); return Number.isFinite(v) ? v : d(q, "USD") * d("USD", a);
  };
  private meOf(acct: string): Me {
    const a = this.accounts.get(acct)!;
    return { accountNumber: acct, currency: a.currency, leverage: a.leverage, balance: a.balance, credit: a.credit, marginCallLevel: a.marginCallLevel, stopOutLevel: a.stopOutLevel, groupName: a.group };
  }
  private quotes(): Record<string, { bid: number; ask: number }> {
    const out: Record<string, { bid: number; ask: number }> = {};
    for (const s of this.price.active()) out[s] = this.price.quote(s);
    return out;
  }
  private realize(acct: string, p: Pos, why: string): void {
    const q = this.price.quote(p.symbol), m = this.meta[p.symbol], a = this.accounts.get(acct)!;
    const closePrice = p.side === "BUY" ? q.bid : q.ask;
    const pnl = (p.side === "BUY" ? closePrice - p.openPrice : p.openPrice - closePrice) * p.volume * m.contractSize * this.fx(m.quoteCurrency, a.currency);
    a.balance = Math.round((a.balance + pnl) * 100) / 100;
    this.open.set(acct, (this.open.get(acct) ?? []).filter((x) => x.id !== p.id));
    this.closed.set(acct, [...(this.closed.get(acct) ?? []), { id: p.id, symbol: p.symbol, side: p.side, volume: p.volume, closePrice, realizedPnl: Math.round(pnl * 100) / 100, closedAt: new Date().toISOString() }]);
    if (a.balance < 0) {
      this.txns.set(acct, [...(this.txns.get(acct) ?? []), { id: `sim-nbp-${++this.seq}`, type: "NEGATIVE_BALANCE_PROTECTION", amount: -a.balance, note: `simulated (${why})`, createdAt: new Date().toISOString() }]);
      a.balance = 0;
    }
  }
  private stopOutPass(acct: string): void {
    for (;;) {
      const ps = this.open.get(acct) ?? []; if (ps.length === 0) return;
      const e = estimate(this.meOf(acct), ps, this.quotes(), this.meta, this.fx);
      if (e.marginLevel == null || e.marginLevel > this.accounts.get(acct)!.stopOutLevel) return;
      const worst = [...ps].sort((x, y) => this.pnlOf(acct, x) - this.pnlOf(acct, y))[0];
      this.realize(acct, worst, "stop-out");
    }
  }
  private pnlOf(acct: string, p: Pos): number {
    const q = this.price.quote(p.symbol);
    return (p.side === "BUY" ? q.bid - p.openPrice : p.openPrice - q.ask) * p.volume;
  }

  async me(acct: string): Promise<Me> { return this.meOf(acct); }
  async positions(acct: string): Promise<Pos[]> { this.stopOutPass(acct); return [...(this.open.get(acct) ?? [])]; }
  async quote(_acct: string, symbol: string): Promise<Quote> { const q = this.price.quote(symbol); return { ...q, tickAt: new Date().toISOString() }; }
  async market(acct: string, symbol: string, side: Side, volume: number, _price: number): Promise<OrderResult> {
    const q = this.price.quote(symbol), fill = side === "BUY" ? q.ask : q.bid, id = `sim-pos-${++this.seq}`;
    this.open.set(acct, [...(this.open.get(acct) ?? []), { id, ticket: 100000 + this.seq, symbol, side, volume, openPrice: fill, contractSize: this.meta[symbol].contractSize }]);
    return { status: 201, orderId: `sim-ord-${this.seq}`, orderStatus: "FILLED", positionId: id, fillPrice: fill, error: null, idempotencyKey: `sim:${this.seq}` };
  }
  async close(acct: string, positionId: string): Promise<{ status: number; error: string | null }> {
    const p = (this.open.get(acct) ?? []).find((x) => x.id === positionId);
    if (!p) return { status: 409, error: "position is not open" };
    this.realize(acct, p, "close"); return { status: 200, error: null };
  }
  async history(acct: string): Promise<Closed[]> { return [...(this.closed.get(acct) ?? [])]; }
  async transactions(acct: string): Promise<Txn[]> { return [...(this.txns.get(acct) ?? [])]; }
}
