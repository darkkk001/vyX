import { Prisma } from "@prisma/client";
import { conversionRate, fxLookupFromQuotes } from "@/lib/fx";
import { computeRealizedPnl } from "@/lib/trading";
import { hedgedUsedMargin, liveUsedMarginFor, requiredMarginFor, type MarginLeg } from "@/lib/margin";

// FX contract (2026-09-26, docs/contracts/fx-and-market-week.md): the inputs of docs/contracts/fx-vectors.json and the
// function that turns them into expected numbers with the SERVER's own formulas. The terminal (C#) and the web trader
// must reproduce every expected value from the same inputs.
//
// Definitions (account currency throughout; rate = conversionRate(quote -> account), the server's rule):
//   pnl            = computeRealizedPnl(side, open, close side of the market) x rate          (BUY closes at bid)
//   margin         = liveUsedMarginFor(side, volume, contractSize, bid, ask, leverage) x rate (close side price)
//   pointValue     = volume x contractSize x 10^-digits x rate                                 (one point's worth)
//   newOrderMargin = requiredMarginFor(volume, contractSize, fill price, leverage) x rate      (BUY at ask, SELL at bid)
//   account: equity = balance + credit + sum(pnl); usedMargin = hedgedUsedMargin(legs, per-symbol hedged %);
//            freeMargin = equity - usedMargin; marginLevel = equity / usedMargin x 100 (null when usedMargin = 0)
//   rate null (no conversion quote, or every one older than 72 h) = the position is UNPRICED: pnl / margin / pointValue
//   null, and it is left out of equity and used margin (the server's risk path: `if (live && rate)`).

type Q = { bid: string; ask: string; ageMs: number };
type SymbolSpec = { name: string; quoteCurrency: string; contractSize: string; digits: number };
type CaseInput = {
  name: string;
  accountCurrency: string;
  leverage: number;
  quotes: Record<string, Q>;
  symbol: SymbolSpec;
  side: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  bid: string;
  ask: string;
};
type AccountInput = {
  name: string;
  accountCurrency: string;
  balance: string;
  credit: string;
  leverage: number;
  quotes: Record<string, Q>;
  positions: { symbol: SymbolSpec; side: "BUY" | "SELL"; volume: string; openPrice: string; bid: string; ask: string; hedgedMarginPct: string }[];
};

const H = 3_600_000;
const fresh = (bid: string, ask: string, ageMs = 5_000): Q => ({ bid, ask, ageMs });
const MARKET: Record<string, Q> = {
  EURUSD: fresh("1.10000", "1.10020"),
  GBPUSD: fresh("1.30000", "1.30020"),
  USDJPY: fresh("150.000", "150.020"),
  EURGBP: fresh("0.84600", "0.84620"),
  USDCAD: fresh("1.36000", "1.36020"),
};
const S = {
  XAUUSD: { name: "XAUUSD", quoteCurrency: "USD", contractSize: "100", digits: 2 },
  USDJPY: { name: "USDJPY", quoteCurrency: "JPY", contractSize: "100000", digits: 3 },
  EURGBP: { name: "EURGBP", quoteCurrency: "GBP", contractSize: "100000", digits: 5 },
  CADJPY: { name: "CADJPY", quoteCurrency: "JPY", contractSize: "100000", digits: 3 },
  GER40: { name: "GER40", quoteCurrency: "EUR", contractSize: "1", digits: 1 },
  JPN225: { name: "JPN225", quoteCurrency: "JPY", contractSize: "1", digits: 0 },
  UK100: { name: "UK100", quoteCurrency: "GBP", contractSize: "1", digits: 1 },
  USDCHF: { name: "USDCHF", quoteCurrency: "CHF", contractSize: "100000", digits: 5 },
} satisfies Record<string, SymbolSpec>;

export const FX_VECTOR_INPUTS: { cases: CaseInput[]; accounts: AccountInput[] } = {
  cases: [
    { name: "USD account, XAUUSD (quote = account, rate 1)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.XAUUSD, side: "BUY", volume: "0.5", openPrice: "4440.00", bid: "4456.35", ask: "4456.53" },
    { name: "USD account, USDJPY (JPY -> USD through the inverse of USDJPY)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.USDJPY, side: "BUY", volume: "1", openPrice: "149.500", bid: "150.000", ask: "150.020" },
    { name: "USD account, EURGBP (GBP -> USD through GBPUSD)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.EURGBP, side: "SELL", volume: "2", openPrice: "0.84750", bid: "0.84600", ask: "0.84620" },
    { name: "USD account, CADJPY (JPY -> USD)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.CADJPY, side: "BUY", volume: "1", openPrice: "109.800", bid: "110.200", ask: "110.240" },
    { name: "USD account, GER40 (EUR -> USD through EURUSD)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.GER40, side: "BUY", volume: "3", openPrice: "18400.0", bid: "18500.0", ask: "18501.0" },
    { name: "USD account, JPN225 (JPY index)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.JPN225, side: "SELL", volume: "5", openPrice: "39200", bid: "39000", ask: "39010" },
    { name: "USD account, UK100 (GBP index)", accountCurrency: "USD", leverage: 100, quotes: MARKET, symbol: S.UK100, side: "BUY", volume: "2", openPrice: "8150.0", bid: "8200.0", ask: "8201.0" },
    { name: "EUR account, XAUUSD (USD -> EUR through the inverse of EURUSD)", accountCurrency: "EUR", leverage: 30, quotes: MARKET, symbol: S.XAUUSD, side: "BUY", volume: "0.1", openPrice: "4440.00", bid: "4456.35", ask: "4456.53" },
    { name: "EUR account, EURGBP (GBP -> EUR through the inverse of EURGBP)", accountCurrency: "EUR", leverage: 30, quotes: MARKET, symbol: S.EURGBP, side: "BUY", volume: "1", openPrice: "0.84500", bid: "0.84600", ask: "0.84620" },
    { name: "EUR account, USDJPY (JPY -> EUR crosses through USD)", accountCurrency: "EUR", leverage: 30, quotes: MARKET, symbol: S.USDJPY, side: "SELL", volume: "1", openPrice: "150.500", bid: "150.000", ask: "150.020" },
    { name: "GBP account, GER40 (EUR -> GBP directly through EURGBP)", accountCurrency: "GBP", leverage: 30, quotes: MARKET, symbol: S.GER40, side: "SELL", volume: "1", openPrice: "18600.0", bid: "18500.0", ask: "18501.0" },
    { name: "JPY account, XAUUSD (USD -> JPY directly through USDJPY)", accountCurrency: "JPY", leverage: 100, quotes: MARKET, symbol: S.XAUUSD, side: "SELL", volume: "0.2", openPrice: "4470.00", bid: "4456.35", ask: "4456.53" },
    { name: "USD account, USDJPY quote 71 h old (still used: the limit is 72 h)", accountCurrency: "USD", leverage: 100, quotes: { USDJPY: { bid: "150.000", ask: "150.020", ageMs: 71 * H } }, symbol: S.USDJPY, side: "BUY", volume: "1", openPrice: "149.500", bid: "150.000", ask: "150.020" },
    { name: "USD account, USDJPY quote 73 h old (too old: unpriced)", accountCurrency: "USD", leverage: 100, quotes: { USDJPY: { bid: "150.000", ask: "150.020", ageMs: 73 * H } }, symbol: S.USDJPY, side: "BUY", volume: "1", openPrice: "149.500", bid: "150.000", ask: "150.020" },
    { name: "USD account, USDCHF with no CHF quote at all (unpriced)", accountCurrency: "USD", leverage: 100, quotes: { EURUSD: MARKET.EURUSD }, symbol: S.USDCHF, side: "BUY", volume: "1", openPrice: "0.90000", bid: "0.90100", ask: "0.90120" },
  ],
  accounts: [
    {
      name: "USD account: gold hedged at 50 %, USDJPY and GER40",
      accountCurrency: "USD", balance: "10000", credit: "500", leverage: 100, quotes: MARKET,
      positions: [
        { symbol: S.XAUUSD, side: "BUY", volume: "0.5", openPrice: "4440.00", bid: "4456.35", ask: "4456.53", hedgedMarginPct: "50" },
        { symbol: S.XAUUSD, side: "SELL", volume: "0.3", openPrice: "4460.00", bid: "4456.35", ask: "4456.53", hedgedMarginPct: "50" },
        { symbol: S.USDJPY, side: "BUY", volume: "1", openPrice: "149.500", bid: "150.000", ask: "150.020", hedgedMarginPct: "200" },
        { symbol: S.GER40, side: "BUY", volume: "3", openPrice: "18400.0", bid: "18500.0", ask: "18501.0", hedgedMarginPct: "200" },
      ],
    },
    {
      name: "EUR account: XAUUSD, EURGBP, USDJPY",
      accountCurrency: "EUR", balance: "5000", credit: "0", leverage: 30, quotes: MARKET,
      positions: [
        { symbol: S.XAUUSD, side: "BUY", volume: "0.1", openPrice: "4440.00", bid: "4456.35", ask: "4456.53", hedgedMarginPct: "200" },
        { symbol: S.EURGBP, side: "BUY", volume: "1", openPrice: "0.84500", bid: "0.84600", ask: "0.84620", hedgedMarginPct: "200" },
        { symbol: S.USDJPY, side: "SELL", volume: "1", openPrice: "150.500", bid: "150.000", ask: "150.020", hedgedMarginPct: "200" },
      ],
    },
    {
      name: "USD account with one unpriced position (USDCHF, no CHF quote): left out of equity and margin",
      accountCurrency: "USD", balance: "2000", credit: "0", leverage: 100, quotes: { EURUSD: MARKET.EURUSD },
      positions: [
        { symbol: S.XAUUSD, side: "BUY", volume: "0.1", openPrice: "4440.00", bid: "4456.35", ask: "4456.53", hedgedMarginPct: "200" },
        { symbol: S.USDCHF, side: "BUY", volume: "1", openPrice: "0.90000", bid: "0.90100", ask: "0.90120", hedgedMarginPct: "200" },
      ],
    },
  ],
};

const D = (v: string | number) => new Prisma.Decimal(v);
const s = (d: Prisma.Decimal | null) => (d == null ? null : d.toString());
const NOW = 1_790_000_000_000; // fixed clock for the ages

function rateFor(quotes: Record<string, Q>, from: string, to: string) {
  return conversionRate(from, to, fxLookupFromQuotes(Object.entries(quotes).map(([symbol, q]) => ({ symbol, bid: q.bid, ask: q.ask, tickAt: new Date(NOW - q.ageMs) })), NOW));
}

export function computeFxVectors(input: typeof FX_VECTOR_INPUTS) {
  const cases = input.cases.map((c) => {
    const rate = rateFor(c.quotes, c.symbol.quoteCurrency, c.accountCurrency);
    const cs = D(c.symbol.contractSize);
    const close = c.side === "BUY" ? c.bid : c.ask;
    const pnl = rate ? computeRealizedPnl({ side: c.side, openPrice: D(c.openPrice), closePrice: close, volume: D(c.volume), contractSize: cs }).mul(rate) : null;
    const margin = rate ? liveUsedMarginFor({ side: c.side, volume: D(c.volume), contractSize: cs, bid: D(c.bid), ask: D(c.ask), leverage: c.leverage }).mul(rate) : null;
    const pointValue = rate ? D(c.volume).mul(cs).mul(D(10).pow(-c.symbol.digits)).mul(rate) : null;
    const fill = c.side === "BUY" ? D(c.ask) : D(c.bid);
    const newOrderMargin = rate ? requiredMarginFor(D(c.volume), cs, fill, c.leverage).mul(rate) : null;
    return { ...c, expect: { rate: s(rate), pnl: s(pnl), margin: s(margin), pointValue: s(pointValue), newOrderMargin: s(newOrderMargin) } };
  });
  const accounts = input.accounts.map((a) => {
    let equity = D(a.balance).add(D(a.credit));
    const legs: MarginLeg[] = [];
    let unpriced = 0;
    for (const p of a.positions) {
      const rate = rateFor(a.quotes, p.symbol.quoteCurrency, a.accountCurrency);
      if (!rate) { unpriced++; continue; }
      const cs = D(p.symbol.contractSize);
      equity = equity.add(computeRealizedPnl({ side: p.side, openPrice: D(p.openPrice), closePrice: p.side === "BUY" ? p.bid : p.ask, volume: D(p.volume), contractSize: cs }).mul(rate));
      const margin = liveUsedMarginFor({ side: p.side, volume: D(p.volume), contractSize: cs, bid: D(p.bid), ask: D(p.ask), leverage: a.leverage }).mul(rate);
      legs.push({ symbolKey: p.symbol.name, side: p.side, volume: D(p.volume), margin, hedgedMarginPct: D(p.hedgedMarginPct) });
    }
    const usedMargin = hedgedUsedMargin(legs);
    const marginLevel = usedMargin.gt(0) ? equity.div(usedMargin).mul(100) : null;
    return { ...a, expect: { equity: s(equity), usedMargin: s(usedMargin), freeMargin: s(equity.sub(usedMargin)), marginLevel: s(marginLevel), unpricedPositions: unpriced } };
  });
  return {
    about: "Generated by scripts/contracts/gen-fx-vectors.ts from the server's own formulas (lib/fx-contract.ts). The terminal (tests/Vyx.Shared.Tests FxContractTests) and the web trader (lib/fx-contract.test.ts) must reproduce every expect value. Do not edit by hand.",
    nowMs: NOW,
    fxMaxAgeMs: 72 * H,
    tolerance: { relative: 1e-9, money: 0.000001 },
    cases,
    accounts,
  };
}
