// Generates docs/contracts/gate-vectors.json BY CALLING THE WEB'S OWN ADMISSION GATES
// (lib/risk.ts, lib/hedging.ts) over a matrix of inputs, and recording the verdict each one returns.
//
// WHY. The L2 cutover needs the ENGINE's order path to refuse everything the web refuses. The ported
// gates live in engine/order-management/src/gates.rs, and engine/order-management/tests/gate_parity.rs
// asserts them against this file — so "the engine agrees with the web" is a measurement, not a claim
// about two pieces of code someone read side by side. Same direction as ask-markup-vectors.json and
// open-chain-vector.json: the web is the oracle.
//
// NO DATABASE, on either side. Every gate's DECISION is pure: the five the web reads an aggregate for
// (max open positions, symbol exposure, broker exposure, daily loss, hedging) are each a trivial test
// over ONE number or one boolean, so the read is stubbed and the real decision logic still runs. That
// is what lets the Rust side take the aggregate as an argument (gates.rs's module doc explains why
// that matters) and keeps this generator and that test fast and deterministic.
//
//   NODE_OPTIONS=--conditions=react-server \
//   npx tsx --tsconfig tsconfig.json scripts/contracts/gen-gate-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import {
  checkTradingHalted,
  checkCloseOnly,
  checkGroupTradingHalted,
  checkGroupCloseOnly,
  checkAccountStatusForOpen,
  checkAccountTradingRights,
  checkSymbolTradingMode,
  checkGroupTradingRestriction,
  checkGroupMaxLot,
  checkGroupMinLot,
  checkGroupLotStep,
  checkGroupAllowedSymbol,
  checkLotStep,
  checkMaxOpenPositions,
  checkSymbolExposure,
  checkBrokerExposure,
  checkMaxDailyLoss,
  checkPriceFreshness,
} from "../../lib/risk";
import { checkHedgingAllowed } from "../../lib/hedging";
import { orderRoute, deskIsOn, SYSTEM_ACCOUNT_ORDER } from "../../lib/dealing-routing";
import {
  checkPreTradeMargin,
  evaluatePreTradeMargin,
  hedgedUsedMargin,
  liveUsedMarginFor,
  type AccountMarginState,
  type MarginLeg,
} from "../../lib/margin";
import { closePriceFor, computeRealizedPnl } from "../../lib/trading";

const D = (v: string) => new Prisma.Decimal(v);
const dec = (v: string | null) => v;
const at = (on: boolean) => (on ? new Date("2026-11-03T10:00:00Z") : null);

type Case = { input: Record<string, unknown>; reject: string | null };
const gates: Record<string, Case[]> = {};
const add = (gate: string, input: Record<string, unknown>, reject: string | null) => {
  (gates[gate] ??= []).push({ input, reject });
};

// ---- broker / group / account flags ----
for (const on of [false, true]) {
  add("trading_halted", { tradingHaltedAt: on }, checkTradingHalted({ tradingHaltedAt: at(on) }));
  add("close_only", { closeOnlyAt: on }, checkCloseOnly({ closeOnlyAt: at(on) }));
  add("group_trading_halted", { tradingHaltedAt: on }, checkGroupTradingHalted({ tradingHaltedAt: at(on) }));
  add("group_close_only", { closeOnlyAt: on }, checkGroupCloseOnly({ closeOnlyAt: at(on) }));
}

const STATUSES = ["ACTIVE", "SUSPENDED", "CLOSED"] as const;
const RIGHTS = ["FULL", "CLOSE_ONLY", "READ_ONLY"] as const;
for (const status of STATUSES) {
  add("account_status_for_open", { status }, checkAccountStatusForOpen({ status }));
  for (const tradingRights of RIGHTS) {
    // intent "open" is the only one an order path uses; status is checked FIRST, which is the detail
    // a port gets wrong (a suspended READ_ONLY account must report "suspended", not "read-only")
    add("account_trading_rights_for_open", { status, tradingRights }, checkAccountTradingRights({ status, tradingRights }, "open"));
  }
}

// ---- side restrictions ----
const MODES = ["BOTH", "BUY_ONLY", "SELL_ONLY"] as const;
for (const mode of MODES) {
  for (const side of ["BUY", "SELL"] as const) {
    add("symbol_trading_mode", { tradingMode: mode, side }, checkSymbolTradingMode(mode, side));
    add("group_trading_restriction", { restriction: mode, side }, checkGroupTradingRestriction(mode, side));
  }
}

// ---- volume ----
// group max: null (no cap), on the cap, just over, well over
for (const [volume, cap] of [
  ["1.00", null],
  ["1.00", "1.00"],
  ["1.01", "1.00"],
  ["50.00", "10.00"],
  ["0.01", "100"],
] as [string, string | null][]) {
  add("group_max_lot", { volume, groupMaxLot: dec(cap) }, checkGroupMaxLot(D(volume), cap == null ? null : D(cap)));
}

// group min: the effective minimum is max(symbolMin, groupMin)
for (const [volume, groupMin, symbolMin] of [
  ["0.01", null, "0.01"],
  ["0.01", "0.10", "0.01"],
  ["0.10", "0.10", "0.01"],
  ["0.05", "0.10", "0.01"],
  ["0.01", "0.005", "0.01"],
  ["0.009", null, "0.01"],
] as [string, string | null, string][]) {
  add(
    "group_min_lot",
    { volume, groupMinLot: dec(groupMin), symbolMinLot: symbolMin },
    checkGroupMinLot(D(volume), groupMin == null ? null : D(groupMin), D(symbolMin))
  );
}

// group step: the grid is effectiveMin + n x effectiveStep, and the MESSAGE depends on whether the
// effective minimum itself sits on the step -- both branches are covered
for (const [volume, groupStep, groupMin, symbolMin, symbolStep] of [
  ["0.05", null, null, "0.01", "0.01"],
  ["0.10", "0.05", null, "0.01", "0.01"],
  ["0.06", "0.05", null, "0.01", "0.01"],
  ["0.11", "0.05", "0.01", "0.01", "0.01"],
  ["0.20", "0.10", "0.10", "0.01", "0.01"],
  ["0.25", "0.10", "0.10", "0.01", "0.01"],
  ["1.00", "0", null, "0.01", "0.01"],
  ["0.03", "0.01", null, "0.01", "0.02"],
] as [string, string | null, string | null, string, string][]) {
  add(
    "group_lot_step",
    { volume, groupLotStep: dec(groupStep), groupMinLot: dec(groupMin), symbolMinLot: symbolMin, symbolLotStep: symbolStep },
    checkGroupLotStep(D(volume), groupStep == null ? null : D(groupStep), groupMin == null ? null : D(groupMin), {
      minLot: D(symbolMin),
      lotStep: D(symbolStep),
    })
  );
}

// the symbol's own grid, including the `lotStep <= 0` skip
for (const [volume, minLot, step] of [
  ["0.01", "0.01", "0.01"],
  ["0.10", "0.01", "0.01"],
  ["0.015", "0.01", "0.01"],
  ["1.00", "0.01", "0"],
  ["1.00", "0.01", "-0.01"],
  ["0.50", "0.10", "0.20"],
  ["0.55", "0.10", "0.20"],
] as [string, string, string][]) {
  add("lot_step", { volume, minLot, lotStep: step }, checkLotStep(D(volume), D(minLot), D(step)));
}

// ---- the group's symbol allowlist ----
for (const [restrict, allowed, symbolId] of [
  [false, [], "s1"],
  [false, ["s2"], "s1"],
  [true, ["s1", "s2"], "s1"],
  [true, ["s2"], "s1"],
  [true, [], "s1"],
] as [boolean, string[], string][]) {
  add("group_allowed_symbol", { restrictSymbols: restrict, allowedSymbolIds: allowed, symbolId }, checkGroupAllowedSymbol(restrict, allowed, symbolId));
}

// ---- the five the web reads an aggregate for: the READ is stubbed, the DECISION is the web's ----
const dbWith = (o: { count?: number; volumeSum?: string | null; amountSum?: string | null; opposite?: boolean; coverageAccountId?: string | null }) =>
  ({
    position: {
      count: async () => o.count ?? 0,
      aggregate: async () => ({ _sum: { volume: o.volumeSum == null ? null : D(o.volumeSum) } }),
      findFirst: async () => (o.opposite ? { id: "p1" } : null),
    },
    broker: { findUnique: async () => ({ coverageAccountId: o.coverageAccountId ?? null }) },
    transaction: { aggregate: async () => ({ _sum: { amount: o.amountSum == null ? null : D(o.amountSum) } }) },
  }) as never;

async function aggregateGates() {
  // max open positions -- note the web's test is `>=`, so being AT the cap already refuses
  for (const [openCount, max] of [
    [0, null],
    [0, 5],
    [4, 5],
    [5, 5],
    [9, 5],
  ] as [number, number | null][]) {
    add("max_open_positions", { openCount, maxOpenPositions: max }, await checkMaxOpenPositions(dbWith({ count: openCount }), "a1", max));
  }

  // symbol exposure -- current + order > max refuses; exactly equal passes
  for (const [current, order, max] of [
    ["0", "1.00", null],
    ["0", "1.00", "5.00"],
    ["4.00", "1.00", "5.00"],
    ["4.01", "1.00", "5.00"],
    ["10.00", "0.01", "5.00"],
    [null, "1.00", "5.00"],
  ] as [string | null, string, string | null][]) {
    add(
      "symbol_exposure",
      { current: dec(current), orderVolume: order, maxExposure: dec(max) },
      await checkSymbolExposure(dbWith({ volumeSum: current }), "a1", "s1", D(order), max == null ? null : D(max))
    );
  }

  // broker exposure
  for (const [current, order, limit] of [
    ["0", "1.00", null],
    ["99.00", "1.00", "100"],
    ["99.50", "1.00", "100"],
    [null, "1.00", "100"],
  ] as [string | null, string, string | null][]) {
    add(
      "broker_exposure",
      { current: dec(current), orderVolume: order, totalExposureLimit: dec(limit) },
      await checkBrokerExposure(dbWith({ volumeSum: current }), "b1", D(order), limit == null ? null : D(limit))
    );
  }

  // daily loss -- realized is SIGNED and a loss is negative; the test is realized <= -max.
  // The day boundary is a parameter now (L2 Step 1c (C)) and the aggregate is stubbed, so the value
  // passed here cannot affect the DECISION this vector pins; the boundary has its own oracle in
  // docs/contracts/broker-day-vectors.json.
  for (const [realized, max] of [
    ["0", null],
    ["0", "100"],
    ["-99.99", "100"],
    ["-100", "100"],
    ["-100.01", "100"],
    ["250", "100"],
    [null, "100"],
  ] as [string | null, string | null][]) {
    add(
      "max_daily_loss",
      { realizedToday: dec(realized), maxDailyLoss: dec(max) },
      await checkMaxDailyLoss(dbWith({ amountSum: realized }), "a1", max == null ? null : D(max), new Date("2026-11-02T22:00:00Z"))
    );
  }

  // hedging -- note the web's test is `!== false`, so null/undefined PASSES
  for (const [allowed, opposite] of [
    [true, true],
    [true, false],
    [false, false],
    [false, true],
  ] as [boolean, boolean][]) {
    add(
      "hedging_allowed",
      { hedgingAllowed: allowed, hasOppositeOpenPosition: opposite },
      await checkHedgingAllowed(dbWith({ opposite }), { hedgingAllowed: allowed }, { accountId: "a1", symbolId: "s1", side: "BUY" })
    );
  }
  // and the null column, which must pass however the book looks
  add(
    "hedging_allowed",
    { hedgingAllowed: true, hasOppositeOpenPosition: true, note: "a NULL hedgingAllowed column resolves to true" },
    await checkHedgingAllowed(dbWith({ opposite: true }), { hedgingAllowed: null }, { accountId: "a1", symbolId: "s1", side: "BUY" })
  );
}

// ---- where an order routes (L2 Step 1c item B) ----
// The engine must not DECIDE routing -- that is a dealer-desk concern. It must refuse anything the web
// would not FILL: a COVERAGE group (the broker's own system coverage account) and anything the web
// would QUEUE for a dealer. These vectors pin the engine's port of orderRoute/deskIsOn.
for (const category of ["B_BOOK", "DEALING", "A_BOOK", "REVERSAL", "COVERAGE"] as const) {
  for (const forceDealingMode of [false, true]) {
    for (const deskAutoFillAt of [null, new Date("2026-11-03T00:00:00Z")]) {
      const deskOn = deskIsOn({ dealingDeskAutoFillAt: deskAutoFillAt });
      add(
        "order_route",
        { category, forceDealingMode, deskOn },
        orderRoute({ category, forceDealingMode }, deskOn)
      );
    }
  }
}
// a missing group routes like B_BOOK
add("order_route", { category: null, forceDealingMode: false, deskOn: true }, orderRoute(null, true));
// and the SYSTEM refusal's exact sentence, which the engine must reproduce
add("system_account_message", { note: "lib/dealing-routing.ts SYSTEM_ACCOUNT_ORDER.error" }, SYSTEM_ACCOUNT_ORDER.error);

// ---- pre-trade margin (L2 Step 1c item D) ----
// checkPreTradeMargin is the pure core of evaluatePreTradeMargin: the PROJECTED margin level against
// the group's own call level. `lte`, not `lt` -- an order landing exactly ON the call level is refused.
for (const [equity, usedMargin, requiredMargin, callLevel] of [
  ["10000", "0", "0", "100"],
  ["10000", "0", "100", "100"],
  ["10000", "0", "10000", "100"],
  ["10000", "0", "9999", "100"],
  ["10000", "5000", "5000", "100"],
  ["10000", "5000", "4999", "100"],
  ["10000", "0", "5000", "200"],
  ["10000", "0", "4999", "200"],
  ["100", "0", "100", "50"],
  ["0", "100", "1", "100"],
] as [string, string, string, string][]) {
  add(
    "pre_trade_margin_level",
    { equity, usedMargin, requiredMargin, marginCallLevel: callLevel },
    checkPreTradeMargin({ equity: D(equity), usedMargin: D(usedMargin), requiredMargin: D(requiredMargin), marginCallLevel: D(callLevel) })
  );
}

// ---- pre-trade margin, the WHOLE decision (L2 Step 1d) ----
// The section above pins `checkPreTradeMargin`, the level core. This one pins what the order path
// actually calls: `evaluatePreTradeMargin` over a loaded margin state -- the conversion rate applied
// to the new leg, the MT5 hedge netting that decides how much margin the leg really adds, the "an
// order that does not increase used margin is always allowed" rule, the group's own call level, and
// the INSUFFICIENT_BALANCE / INSUFFICIENT_MARGIN split.
//
// The state is built here with `loadAccountMarginState`'s own formulas rather than read from a
// database: each open position is given bid == ask == its current price, so `liveUsedMarginFor`
// reduces to `requiredMarginFor(volume, contractSize, price, leverage) * rate` -- which is exactly
// what engine/order-management/src/calc.rs `used_margin` computes for a position carrying that same
// bid/ask pair. That is what lets ONE vector drive both sides.
//
// NO_CONVERSION_RATE is the route's answer, not the gate's: `loadAccountMarginState` returns null when
// any open position's quote currency (or the new order's) has no rate, and
// app/api/trade/orders/route.ts turns a null state into this code. The engine's
// `calc::pre_trade_margin_decision` folds both halves into one function, so the vector asks for the
// decision the trader actually gets.
type MarginPosition = { symbol: string; side: "BUY" | "SELL"; volume: string; contractSize: string; openPrice: string; price: string; rate: string | null; hedgedMarginPct: string };
type MarginNewOrder = { symbol: string; side: "BUY" | "SELL"; volume: string; contractSize: string; fillPrice: string; rate: string | null; hedgedMarginPct: string };
type MarginCase = { note: string; leverage: number; marginCallLevel: string; balance: string; credit: string; positions: MarginPosition[]; newOrder: MarginNewOrder };

function marginDecision(c: MarginCase): string | null {
  if (c.positions.some((p) => p.rate == null) || c.newOrder.rate == null) return "NO_CONVERSION_RATE";
  let equity = D(c.balance).add(D(c.credit));
  const legs: MarginLeg[] = [];
  for (const p of c.positions) {
    const rate = D(p.rate!);
    const price = D(p.price);
    const margin = liveUsedMarginFor({ side: p.side, volume: D(p.volume), contractSize: D(p.contractSize), accountBid: price, accountAsk: price, leverage: c.leverage }).mul(rate);
    equity = equity.add(
      computeRealizedPnl({ side: p.side, openPrice: D(p.openPrice), closePrice: closePriceFor(p.side, price, price), volume: D(p.volume), contractSize: D(p.contractSize) }).mul(rate)
    );
    legs.push({ symbolKey: p.symbol, side: p.side, volume: D(p.volume), margin, hedgedMarginPct: D(p.hedgedMarginPct) });
  }
  const state: AccountMarginState = {
    account: { balance: D(c.balance), credit: D(c.credit), currency: "USD", brokerId: "broker" },
    equity,
    usedMargin: hedgedUsedMargin(legs),
    legs,
    // only the NEW leg's % is read through pctFor; the open ones carry their own
    pctFor: () => D(c.newOrder.hedgedMarginPct),
    rateFor: () => D(c.newOrder.rate!),
    openPositions: c.positions.length,
  };
  const rejection = evaluatePreTradeMargin(state, {
    leverage: c.leverage,
    marginCallLevel: D(c.marginCallLevel),
    newOrderContractSize: D(c.newOrder.contractSize),
    newOrderQuoteCurrency: "QUOTE",
    newOrderVolume: D(c.newOrder.volume),
    newOrderFillPrice: D(c.newOrder.fillPrice),
    newOrderSide: c.newOrder.side,
    newOrderSymbolId: c.newOrder.symbol,
  });
  return rejection?.error ?? null;
}

const FX = { symbol: "EURUSD", contractSize: "100000", hedgedMarginPct: "200" };
const flat = (over: Partial<MarginPosition> = {}): MarginPosition => ({ ...FX, side: "BUY", volume: "1", openPrice: "1.1000", price: "1.1000", rate: "1", ...over });
const order = (over: Partial<MarginNewOrder> = {}): MarginNewOrder => ({ ...FX, side: "BUY", volume: "1", fillPrice: "1.1000", rate: "1", ...over });

const marginCases: MarginCase[] = [
  // --- nothing open: the balance alone has to carry the leg ---
  { note: "flat account, plenty of room", leverage: 100, marginCallLevel: "100", balance: "10000", credit: "0", positions: [], newOrder: order() },
  { note: "flat account, the leg costs more than the balance", leverage: 100, marginCallLevel: "100", balance: "500", credit: "0", positions: [], newOrder: order() },
  { note: "credit counts toward the funds, so the same leg fits", leverage: 100, marginCallLevel: "100", balance: "500", credit: "10000", positions: [], newOrder: order() },
  { note: "credit alone, no balance", leverage: 100, marginCallLevel: "100", balance: "0", credit: "10000", positions: [], newOrder: order() },

  // --- the group's own call level, not a hardcoded 100 ---
  { note: "level 100: 1100 of margin on 1200 equity passes", leverage: 100, marginCallLevel: "100", balance: "1200", credit: "0", positions: [], newOrder: order() },
  { note: "level 100 exactly: lte refuses", leverage: 100, marginCallLevel: "100", balance: "1100", credit: "0", positions: [], newOrder: order() },
  { note: "the SAME order the default would pass, refused at level 200", leverage: 100, marginCallLevel: "200", balance: "1200", credit: "0", positions: [], newOrder: order() },
  { note: "level 200 with room to spare", leverage: 100, marginCallLevel: "200", balance: "10000", credit: "0", positions: [], newOrder: order() },
  { note: "a lenient group (level 50) passes what 100 would refuse", leverage: 100, marginCallLevel: "50", balance: "1100", credit: "0", positions: [], newOrder: order() },

  // --- conversion: the leg's margin is in the QUOTE currency until the rate is applied ---
  { note: "rate 0.0067 (a JPY-quoted leg on a USD account): 150000 JPY of margin is 1005 USD, which fits", leverage: 100, marginCallLevel: "100", balance: "3000", credit: "0", positions: [], newOrder: order({ symbol: "USDJPY", fillPrice: "150.00", rate: "0.0067" }) },
  { note: "the SAME leg at rate 1 is sized as if JPY were USD, and refused -- the rate is not decoration", leverage: 100, marginCallLevel: "100", balance: "3000", credit: "0", positions: [], newOrder: order({ symbol: "USDJPY", fillPrice: "150.00", rate: "1" }) },
  { note: "a GBP-quoted leg at rate 1 would fit", leverage: 100, marginCallLevel: "100", balance: "1000", credit: "0", positions: [], newOrder: order({ symbol: "EURGBP", fillPrice: "0.8500", rate: "1" }) },
  { note: "the SAME leg at rate 1.35 does not: a rate above 1 makes it dearer", leverage: 100, marginCallLevel: "100", balance: "1000", credit: "0", positions: [], newOrder: order({ symbol: "EURGBP", fillPrice: "0.8500", rate: "1.35" }) },
  { note: "no rate for the new leg", leverage: 100, marginCallLevel: "100", balance: "1000000", credit: "0", positions: [], newOrder: order({ rate: null }) },
  { note: "no rate for an OPEN position: the whole order is refused, however small", leverage: 100, marginCallLevel: "100", balance: "1000000", credit: "0", positions: [flat({ symbol: "USDJPY", price: "150.00", openPrice: "150.00", rate: null })], newOrder: order({ volume: "0.01" }) },
  { note: "an open position converted at its own rate", leverage: 100, marginCallLevel: "100", balance: "3000", credit: "0", positions: [flat({ symbol: "USDJPY", price: "150.00", openPrice: "150.00", rate: "0.0067" })], newOrder: order() },

  // --- hedge netting: how much margin the leg really ADDS ---
  { note: "an opposite leg at pct 200 pays in full, like any other: 2200 of margin fits in 2300", leverage: 100, marginCallLevel: "100", balance: "2300", credit: "0", positions: [flat()], newOrder: order({ side: "SELL" }) },
  { note: "and does not fit in 2200 -- exactly on the call level", leverage: 100, marginCallLevel: "100", balance: "2200", credit: "0", positions: [flat()], newOrder: order({ side: "SELL" }) },
  { note: "the same hedge at pct 0 adds nothing, so it is allowed with no room at all", leverage: 100, marginCallLevel: "100", balance: "1150", credit: "0", positions: [flat({ hedgedMarginPct: "0" })], newOrder: order({ side: "SELL", hedgedMarginPct: "0" }) },
  { note: "a hedge at pct 50 adds some, but less than full", leverage: 100, marginCallLevel: "100", balance: "1500", credit: "0", positions: [flat({ hedgedMarginPct: "50" })], newOrder: order({ side: "SELL", hedgedMarginPct: "50" }) },
  { note: "same side, same symbol: nothing is hedged", leverage: 100, marginCallLevel: "100", balance: "1500", credit: "0", positions: [flat()], newOrder: order() },
  { note: "a hedge on a DIFFERENT symbol does not net", leverage: 100, marginCallLevel: "100", balance: "1500", credit: "0", positions: [flat({ symbol: "GBPUSD", price: "1.2700", openPrice: "1.2700" })], newOrder: order({ side: "SELL" }) },
  { note: "the open position's pct wins over the new leg's (first leg booked for the symbol)", leverage: 100, marginCallLevel: "100", balance: "1150", credit: "0", positions: [flat({ hedgedMarginPct: "0" })], newOrder: order({ side: "SELL", hedgedMarginPct: "200" }) },
  { note: "a partial hedge: 0.4 lots against 1", leverage: 100, marginCallLevel: "100", balance: "1500", credit: "0", positions: [flat({ hedgedMarginPct: "0" })], newOrder: order({ side: "SELL", volume: "0.4", hedgedMarginPct: "0" }) },

  // --- floating P&L moves the equity the level is judged against ---
  { note: "a floating LOSS on the open leg leaves less room", leverage: 100, marginCallLevel: "100", balance: "3000", credit: "0", positions: [flat({ openPrice: "1.2000" })], newOrder: order() },
  { note: "a floating PROFIT on the open leg makes room", leverage: 100, marginCallLevel: "100", balance: "1200", credit: "0", positions: [flat({ openPrice: "1.0000" })], newOrder: order() },

  // --- the two refusals the trader reads apart ---
  { note: "funds cannot carry the leg even with nothing open: BALANCE", leverage: 100, marginCallLevel: "100", balance: "100", credit: "0", positions: [], newOrder: order() },
  { note: "funds could, but what is open leaves too little: MARGIN", leverage: 100, marginCallLevel: "100", balance: "2000", credit: "0", positions: [flat({ openPrice: "1.2000" })], newOrder: order() },
  { note: "zero funds", leverage: 100, marginCallLevel: "100", balance: "0", credit: "0", positions: [], newOrder: order({ volume: "0.01" }) },

  // --- leverage, because the requirement scales with it ---
  { note: "1:500 makes the same leg a fifth of the margin", leverage: 500, marginCallLevel: "100", balance: "300", credit: "0", positions: [], newOrder: order() },
  { note: "1:1 makes it unaffordable", leverage: 1, marginCallLevel: "100", balance: "10000", credit: "0", positions: [], newOrder: order() },
];

for (const c of marginCases) {
  add("pre_trade_margin", c as unknown as Record<string, unknown>, marginDecision(c));
}

// ---- price freshness ----
// Ages chosen well clear of the 3000 ms threshold on both sides: the web reads Date.now() itself, so a
// case within a few ms of the boundary would be racy rather than a parity test.
for (const ageMs of [0, 500, 2500, 3500, 60_000]) {
  add("price_freshness", { tickAgeMs: ageMs }, checkPriceFreshness({ tickAt: new Date(Date.now() - ageMs) }));
}
add("price_freshness", { tickAgeMs: null, note: "no tick at all" }, checkPriceFreshness(null));

async function main() {
  await aggregateGates();
  const out = {
    generatedBy: "scripts/contracts/gen-gate-vectors.ts",
    note: "the WEB's own admission gates (lib/risk.ts, lib/hedging.ts), input -> verdict; engine/order-management/tests/gate_parity.rs asserts the ported gates against this",
    fillPriceMaxAgeMs: 3000,
    gates,
  };
  const total = Object.values(gates).reduce((n, cs) => n + cs.length, 0);
  const rejects = Object.values(gates).reduce((n, cs) => n + cs.filter((c) => c.reject != null).length, 0);
  const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "gate-vectors.json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}: ${Object.keys(gates).length} gates, ${total} cases (${rejects} reject, ${total - rejects} pass)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
