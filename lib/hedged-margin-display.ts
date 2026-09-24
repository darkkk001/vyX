// Client-side (plain number) copy of lib/margin.ts hedgedUsedMargin, for WebTrader's account panel: the margin and
// margin level it DISPLAYS must be the ones the server stops out on. Same formula, same order of operations; the server
// (Decimal) stays authoritative. lib/hedged-margin.test.ts checks the two agree.
export type DisplayMarginLeg = { symbolKey: string; side: "BUY" | "SELL"; volume: number; margin: number; hedgedMarginPct: number };

export function hedgedUsedMarginDisplay(legs: DisplayMarginLeg[]): number {
  const bySymbol = new Map<string, { buyVol: number; sellVol: number; buyMargin: number; sellMargin: number; pct: number }>();
  for (const leg of legs) {
    const s = bySymbol.get(leg.symbolKey) ?? { buyVol: 0, sellVol: 0, buyMargin: 0, sellMargin: 0, pct: leg.hedgedMarginPct };
    if (leg.side === "BUY") { s.buyVol += leg.volume; s.buyMargin += leg.margin; }
    else { s.sellVol += leg.volume; s.sellMargin += leg.margin; }
    bySymbol.set(leg.symbolKey, s);
  }
  let total = 0;
  for (const s of bySymbol.values()) {
    const buyIsLarger = s.buyVol >= s.sellVol;
    const [l, ml, sv, ms] = buyIsLarger ? [s.buyVol, s.buyMargin, s.sellVol, s.sellMargin] : [s.sellVol, s.sellMargin, s.buyVol, s.buyMargin];
    if (sv === 0) { total += ml + ms; continue; }
    const covered = (ml * sv) / l;
    total += ml - covered + ((ms + covered) * s.pct) / 200;
  }
  return total;
}
