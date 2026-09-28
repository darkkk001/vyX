// The bot's OWN margin estimate: for sizing positions and pacing ramps, and to explain an inferred stop-out. It is
// never the authority -- the server decides every stop-out; this only predicts where it should happen.
// Floating P/L: a BUY is valued at the bid, a SELL at the ask. Margin: volume x contract x current price / leverage;
// a hedged pair on one symbol pays |buy - sell| lots in full plus min(buy, sell) lots x hedgedMarginPct / 100
// (200 = both legs in full, 100 = one leg, 0 = nothing), the platform's rule. Quote -> account conversion uses the
// given rate (1 when the currencies match).
import type { Me, Pos } from "./trade-client";

export type SymbolMeta = { contractSize: number; quoteCurrency: string; hedgedMarginPct: number };
export type Estimate = { balance: number; equity: number; floating: number; usedMargin: number; marginLevel: number | null };

export function estimate(me: Me, positions: Pos[], quotes: Record<string, { bid: number; ask: number }>, meta: Record<string, SymbolMeta>, fx: (quote: string, account: string) => number): Estimate {
  let floating = 0, used = 0;
  const bySymbol = new Map<string, Pos[]>();
  for (const p of positions) bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
  for (const [symbol, ps] of bySymbol) {
    const q = quotes[symbol], m = meta[symbol];
    if (!q || !m) continue;
    const rate = fx(m.quoteCurrency, me.currency);
    let buy = 0, sell = 0;
    for (const p of ps) {
      floating += (p.side === "BUY" ? q.bid - p.openPrice : p.openPrice - q.ask) * p.volume * m.contractSize * rate;
      if (p.side === "BUY") buy += p.volume; else sell += p.volume;
    }
    const perLot = (m.contractSize * ((q.bid + q.ask) / 2) * rate) / me.leverage;
    used += (Math.abs(buy - sell) + Math.min(buy, sell) * (m.hedgedMarginPct / 100)) * perLot;
  }
  const equity = me.balance + me.credit + floating;
  return { balance: me.balance, equity: round2(equity), floating: round2(floating), usedMargin: round2(used), marginLevel: used > 0 ? round2((equity / used) * 100) : null };
}

/** Lots so that the new position's margin is `pctOfEquity` % of the equity (rounded DOWN to the 0.01 lot step). */
export function lotsForMarginPct(pctOfEquity: number, equity: number, leverage: number, contractSize: number, price: number, rate: number): number {
  const perLot = (contractSize * price * rate) / leverage;
  const lots = Math.floor(((pctOfEquity / 100) * equity) / perLot / 0.01) * 0.01;
  return Number(Math.max(0.01, lots).toFixed(2));
}

/**
 * Lots so that the stop-out falls at a price move of `pct` % against the position: equity E, loss per lot per 1% =
 * contract x price x rate / 100, and at the stop-out equity = stopOutLevel % of the used margin. Solves
 *   E - lots * cs * P * rate * pct / 100 = (stopOut / 100) * lots * cs * P * rate / leverage
 * (rounded DOWN to 0.01). The account is wiped out at pct + stopOut / leverage %, which a scenario's gap must stay under.
 */
export function lotsForStopOutAt(pct: number, equity: number, leverage: number, stopOutLevel: number, contractSize: number, price: number, rate: number): number {
  const perLotValue = contractSize * price * rate;
  const lots = Math.floor(equity / (perLotValue * (pct / 100 + stopOutLevel / 100 / leverage)) / 0.01) * 0.01;
  return Number(Math.max(0.01, lots).toFixed(2));
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
