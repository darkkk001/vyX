import { Prisma } from "@prisma/client";
import { closePriceFor, computeRealizedPnl } from "@/lib/trading";
import { evaluatePreTradeMargin, hedgedUsedMargin, liveUsedMarginFor, type AccountMarginState, type MarginLeg } from "@/lib/margin";
import { effectiveOpenLeverage, hmrRefusalText, type HmrState } from "@/lib/hmr";

// Contract vectors for the leverage rules + HMR plugin (owner spec 2026-11-06), generated FROM THE SERVER'S OWN FUNCTIONS
// (lib/hmr.ts effectiveOpenLeverage / hmrRefusalText, lib/margin.ts liveUsedMarginFor / hedgedUsedMargin / evaluatePreTradeMargin),
// so the web is the source of truth the engine (engine/order-management/src/hmr.rs, calc.rs) is pinned to:
//   * engine/order-management/tests/gate_parity.rs asserts every case in docs/contracts/leverage-hmr-vectors.json;
//   * lib/leverage-hmr-contract.test.ts recomputes every expected value here and fails if the file and the web ever disagree.
// Regenerate:  NODE_OPTIONS=--conditions=react-server npx tsx --tsconfig tsconfig.json scripts/contracts/gen-leverage-hmr-vectors.ts

const D = (v: string | number) => new Prisma.Decimal(v);

export type OpenLeverageInput = {
  note: string;
  accountLeverage: number;
  groupMax: number | null;
  symbol: string;
  now: string; // ISO UTC
  hmrEnabled: boolean;
  windows: { currency: string; startsAt: string; endsAt: string; leverage: number; enabled: boolean }[];
  correlations: Record<string, string[]>;
};
export type OpenLeverageExpect = { leverage: number; openLeverage: number | null; hmr: { currency: string; leverage: number; endsAt: string } | null; refusalText: string | null };

export function stateOf(i: OpenLeverageInput): HmrState {
  return {
    enabled: i.hmrEnabled,
    windows: i.windows.map((w, n) => ({ id: String(n), currency: w.currency, startsAt: new Date(w.startsAt), endsAt: new Date(w.endsAt), leverage: w.leverage, enabled: w.enabled })),
    symbolsByCurrency: new Map(Object.entries(i.correlations).map(([c, s]) => [c, new Set(s)])),
  };
}

export function openLeverageExpect(i: OpenLeverageInput): OpenLeverageExpect {
  const r = effectiveOpenLeverage({ accountLeverage: i.accountLeverage, groupMax: i.groupMax, state: stateOf(i), symbol: i.symbol, now: new Date(i.now) });
  return {
    leverage: r.leverage,
    openLeverage: r.openLeverage,
    hmr: r.hmr ? { currency: r.hmr.currency, leverage: r.hmr.leverage, endsAt: r.hmr.endsAt.toISOString() } : null,
    refusalText: r.hmr ? hmrRefusalText(r.hmr) : null,
  };
}

const WIN = (currency: string, startsAt: string, endsAt: string, leverage: number, enabled = true) => ({ currency, startsAt, endsAt, leverage, enabled });
const MAP = { USD: ["XAUUSD", "EURUSD", "US30"], EUR: ["EURUSD", "GER40"], GBP: ["GBPUSD"] };
const T = (hhmm: string) => `2026-11-06T${hhmm}:00.000Z`;
const OL = (over: Partial<OpenLeverageInput>): OpenLeverageInput => ({
  note: "",
  accountLeverage: 500,
  groupMax: 500,
  symbol: "XAUUSD",
  now: T("13:30"),
  hmrEnabled: true,
  windows: [WIN("USD", T("13:00"), T("14:30"), 20)],
  correlations: MAP,
  ...over,
});

export const OPEN_LEVERAGE_INPUTS: OpenLeverageInput[] = [
  OL({ note: "a window for the symbol's currency lowers the new position to the window's leverage" }),
  OL({ note: "plugin off: no effect", hmrEnabled: false }),
  OL({ note: "no window at all", windows: [] }),
  OL({ note: "before the window starts", now: T("12:59") }),
  OL({ note: "exactly at startsAt: active (inclusive)", now: T("13:00") }),
  OL({ note: "one minute before endsAt: active", now: T("14:29") }),
  OL({ note: "exactly at endsAt: over (exclusive)", now: T("14:30") }),
  OL({ note: "a symbol outside the currency's list is unaffected", symbol: "EURGBP" }),
  OL({ note: "a disabled window is ignored", windows: [WIN("USD", T("13:00"), T("14:30"), 20, false)] }),
  OL({ note: "a window above the account leverage changes nothing", accountLeverage: 100, groupMax: 100, windows: [WIN("USD", T("13:00"), T("14:30"), 200)] }),
  OL({ note: "a window equal to the account leverage changes nothing (nothing stored)", accountLeverage: 100, groupMax: 100, windows: [WIN("USD", T("13:00"), T("14:30"), 100)] }),
  OL({ note: "overlapping windows on one currency: the lowest wins", windows: [WIN("USD", T("13:00"), T("15:00"), 50), WIN("USD", T("13:15"), T("14:00"), 10)] }),
  OL({ note: "overlapping windows of two currencies touching EURUSD: the lowest wins", symbol: "EURUSD", windows: [WIN("USD", T("13:00"), T("15:00"), 50), WIN("EUR", T("13:00"), T("16:00"), 25)] }),
  OL({ note: "the same two, after the lower one ended: the other still applies", symbol: "EURUSD", now: T("15:30"), windows: [WIN("USD", T("13:00"), T("15:00"), 50), WIN("EUR", T("13:00"), T("16:00"), 25)] }),
  OL({ note: "a window for a currency the symbol is not listed under", symbol: "GBPUSD", windows: [WIN("EUR", T("13:00"), T("15:00"), 25)] }),
  OL({ note: "an account above its group (legacy data) is held to the group's maximum", accountLeverage: 1000, groupMax: 500, windows: [] }),
  OL({ note: "group maximum below the window: the group wins, no HMR binding", accountLeverage: 500, groupMax: 10, windows: [WIN("USD", T("13:00"), T("14:30"), 20)] }),
  OL({ note: "no group ceiling (null): the account leverage and the window", accountLeverage: 500, groupMax: null }),
];

// ---- margin with a per-position leverage ----
export type MarginPosition = { symbol: string; side: "BUY" | "SELL"; volume: string; openPrice: string; price: string; contractSize: string; hedgedMarginPct: string; rate: string | null; openLeverage: number | null };
export type MarginNewOrder = { symbol: string; side: "BUY" | "SELL"; volume: string; fillPrice: string; contractSize: string; hedgedMarginPct: string; rate: string | null; leverage: number | null };
export type MarginCase = { note: string; leverage: number; marginCallLevel: string; balance: string; credit: string; positions: MarginPosition[]; newOrder: MarginNewOrder };

const pos = (over: Partial<MarginPosition> = {}): MarginPosition => ({ symbol: "XAUUSD", side: "BUY", volume: "1", openPrice: "2000", price: "2000", contractSize: "100", hedgedMarginPct: "200", rate: "1", openLeverage: null, ...over });
const ord = (over: Partial<MarginNewOrder> = {}): MarginNewOrder => ({ symbol: "XAUUSD", side: "BUY", volume: "1", fillPrice: "2000", contractSize: "100", hedgedMarginPct: "200", rate: "1", leverage: null, ...over });

export const MARGIN_CASES: MarginCase[] = [
  { note: "a position opened under HMR keeps its margin leverage: 200000 at 1:20 = 10000, not 400 at the account's 1:500", leverage: 500, marginCallLevel: "100", balance: "12000", credit: "0", positions: [pos({ openLeverage: 20 })], newOrder: ord({ leverage: null, volume: "0.01" }) },
  { note: "the SAME position without openLeverage uses the account's leverage, so the new order has room", leverage: 500, marginCallLevel: "100", balance: "1000", credit: "0", positions: [pos()], newOrder: ord({ volume: "0.5" }) },
  { note: "a new order under HMR needs more margin: 200000 at 1:20 = 10000 is refused on 5000", leverage: 500, marginCallLevel: "100", balance: "5000", credit: "0", positions: [], newOrder: ord({ leverage: 20 }) },
  { note: "the same order at the account's 1:500 = 400 is allowed", leverage: 500, marginCallLevel: "100", balance: "5000", credit: "0", positions: [], newOrder: ord() },
  { note: "HMR order that fits: 200000 at 1:20 = 10000 on 20000", leverage: 500, marginCallLevel: "100", balance: "20000", credit: "0", positions: [], newOrder: ord({ leverage: 20 }) },
  { note: "HMR order refused for balance (the funds cannot carry it even with nothing open)", leverage: 500, marginCallLevel: "100", balance: "9000", credit: "0", positions: [], newOrder: ord({ leverage: 20 }) },
  { note: "HMR order refused for margin (the balance could carry it, open positions leave too little)", leverage: 500, marginCallLevel: "100", balance: "9000", credit: "0", positions: [pos({ openLeverage: 20, volume: "0.5" })], newOrder: ord({ leverage: 20, volume: "0.5" }) },
  { note: "two positions, one HMR one not, each at its own leverage: 5000 + 400", leverage: 500, marginCallLevel: "100", balance: "5600", credit: "0", positions: [pos({ openLeverage: 40, volume: "1" }), pos({ symbol: "EURUSD", contractSize: "100000", openPrice: "1.1", price: "1.1", volume: "0.5" })], newOrder: ord({ symbol: "EURUSD", contractSize: "100000", fillPrice: "1.1", volume: "0.1" }) },
  { note: "an opposite leg at hedged pct 50 nets using each leg's own margin (HMR leg 10000, account-leverage leg 400)", leverage: 500, marginCallLevel: "100", balance: "30000", credit: "0", positions: [pos({ openLeverage: 20, hedgedMarginPct: "50" })], newOrder: ord({ side: "SELL", hedgedMarginPct: "50" }) },
  { note: "floating loss on an HMR position lowers the equity the level is judged on", leverage: 500, marginCallLevel: "100", balance: "20000", credit: "0", positions: [pos({ openLeverage: 20, openPrice: "2050" })], newOrder: ord({ volume: "0.1", leverage: 20 }) },
  { note: "a JPY-quoted leg at rate 0.0067 under HMR", leverage: 500, marginCallLevel: "100", balance: "3000", credit: "0", positions: [], newOrder: ord({ symbol: "USDJPY", contractSize: "100000", fillPrice: "150", volume: "1", rate: "0.0067", leverage: 100 }) },
  { note: "no rate for the new leg", leverage: 500, marginCallLevel: "100", balance: "1000000", credit: "0", positions: [], newOrder: ord({ rate: null, leverage: 20 }) },
];

export type MarginExpect = { usedMargin: string | null; reject: string | null };

export function marginExpect(c: MarginCase): MarginExpect {
  if (c.positions.some((p) => p.rate == null) || c.newOrder.rate == null) return { usedMargin: null, reject: "NO_CONVERSION_RATE" };
  let equity = D(c.balance).add(D(c.credit));
  const legs: MarginLeg[] = [];
  for (const p of c.positions) {
    const rate = D(p.rate!);
    const price = D(p.price);
    // the production rule: per position, openLeverage ?? account leverage (lib/margin.ts loadAccountMarginState)
    const margin = liveUsedMarginFor({ side: p.side, volume: D(p.volume), contractSize: D(p.contractSize), accountBid: price, accountAsk: price, leverage: p.openLeverage ?? c.leverage }).mul(rate);
    equity = equity.add(computeRealizedPnl({ side: p.side, openPrice: D(p.openPrice), closePrice: closePriceFor(p.side, price, price), volume: D(p.volume), contractSize: D(p.contractSize) }).mul(rate));
    legs.push({ symbolKey: p.symbol, side: p.side, volume: D(p.volume), margin, hedgedMarginPct: D(p.hedgedMarginPct) });
  }
  const usedMargin = hedgedUsedMargin(legs);
  const state: AccountMarginState = {
    account: { balance: D(c.balance), credit: D(c.credit), currency: "USD", brokerId: "broker" },
    equity,
    usedMargin,
    legs,
    pctFor: () => D(c.newOrder.hedgedMarginPct),
    rateFor: () => D(c.newOrder.rate!),
    openPositions: c.positions.length,
  };
  const rejection = evaluatePreTradeMargin(state, {
    leverage: c.newOrder.leverage ?? c.leverage,
    marginCallLevel: D(c.marginCallLevel),
    newOrderContractSize: D(c.newOrder.contractSize),
    newOrderQuoteCurrency: "QUOTE",
    newOrderVolume: D(c.newOrder.volume),
    newOrderFillPrice: D(c.newOrder.fillPrice),
    newOrderSide: c.newOrder.side,
    newOrderSymbolId: c.newOrder.symbol,
  });
  return { usedMargin: usedMargin.toString(), reject: rejection?.error ?? null };
}

export function computeLeverageHmrVectors() {
  return {
    generatedBy: "scripts/contracts/gen-leverage-hmr-vectors.ts",
    note: "the WEB's own HMR effective-leverage and per-position margin rules (lib/hmr.ts, lib/margin.ts), input -> verdict; engine/order-management/tests/gate_parity.rs asserts the engine against this",
    open_leverage: OPEN_LEVERAGE_INPUTS.map((input) => ({ input, expect: openLeverageExpect(input) })),
    margin: MARGIN_CASES.map((input) => ({ input, expect: marginExpect(input) })),
  };
}
