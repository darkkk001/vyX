import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl, closePriceFor } from "@/lib/trading";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { loadSellAskRules, valuationAsk } from "@/lib/ask-markup";

export type AccountMarginSnapshot = {
  accountId: string;
  accountNumber: string;
  balance: number;
  credit: number;
  floatingPnl: number;
  equity: number;
  usedMargin: number;
  exposure: number;
  positionCount: number;
  marginCallLevel: number;
  stopOutLevel: number;
  marginLevel: number | null; // null = no used margin (no fresh price for any open position)
};

// Shared by the Risk Dashboard stats (app/manage/(shell)/risk/page.tsx),
// the Risk report CSV (app/api/manage/reports/risk/route.ts), and the
// Margin monitoring page (app/manage/(shell)/margin/page.tsx) -- was
// duplicated across the first two in Phase A, factored out here rather
// than adding a third copy. Margin level = equity / usedMargin * 100.
//
// Stage 2 (docs/RUST-CUTOVER-PLAN.md): equity = balance + CREDIT + floating (F1, credit Model A; credit was
// left out before), and every figure is summed in Decimal, turned into a number only in the returned
// snapshot (it used to add JS numbers). floatingPnl is returned on its own, because equity - balance is no
// longer the floating P&L once credit is in equity.
export async function computeAccountMarginSnapshots(prisma: PrismaClient, brokerId: string): Promise<AccountMarginSnapshot[]> {
  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: {
        select: { id: true, accountNumber: true, balance: true, credit: true, leverage: true, currency: true, group: { select: { marginCallLevel: true, stopOutLevel: true } } },
      },
      symbol: { select: { name: true, contractSize: true, quoteCurrency: true } },
    },
  });

  // a SELL is valued at its account's ask (lib/ask-markup.ts, owner decision 2026-09-26): the price it closes at
  const [priceBySymbol, fx, hedgedPct, askRules] = await Promise.all([
    getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]),
    loadFxLookup(prisma, positions.map((p) => [p.symbol.quoteCurrency, p.account.currency] as const)),
    loadHedgedMarginPct(prisma, brokerId),
    loadSellAskRules(prisma, positions),
  ]);
  const legsByAccount = new Map<string, MarginLeg[]>();

  type Acc = { accountId: string; accountNumber: string; balance: Prisma.Decimal; credit: Prisma.Decimal; floating: Prisma.Decimal; usedMargin: Prisma.Decimal; exposure: Prisma.Decimal; positionCount: number; marginCallLevel: Prisma.Decimal; stopOutLevel: Prisma.Decimal };
  const byAccount = new Map<string, Acc>();
  for (const p of positions) {
    const acc = byAccount.get(p.account.id) ?? {
      accountId: p.account.id,
      accountNumber: p.account.accountNumber,
      balance: p.account.balance,
      credit: p.account.credit,
      floating: new Prisma.Decimal(0),
      usedMargin: new Prisma.Decimal(0),
      exposure: new Prisma.Decimal(0),
      positionCount: 0,
      marginCallLevel: p.account.group?.marginCallLevel ?? new Prisma.Decimal(100),
      stopOutLevel: p.account.group?.stopOutLevel ?? new Prisma.Decimal(50),
    };
    acc.exposure = acc.exposure.add(p.volume);
    acc.positionCount += 1;

    const live = priceBySymbol.get(p.symbol.name);
    // quote -> account currency (lib/fx.ts); no rate = counted like no price, never as if it were 1
    const rate = conversionRate(p.symbol.quoteCurrency, p.account.currency, fx);
    if (live && rate) {
      const ask = valuationAsk(askRules, p, live.bid, live.ask);
      const currentPrice = closePriceFor(p.side, live.bid, ask);
      acc.floating = acc.floating.add(computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).mul(rate));
      const margin = liveUsedMarginFor({ side: p.side, volume: p.volume, contractSize: p.symbol.contractSize, bid: live.bid, ask, leverage: p.account.leverage }).mul(rate);
      const legs = legsByAccount.get(p.account.id) ?? [];
      legs.push({ symbolKey: p.symbolId, side: p.side, volume: p.volume, margin, hedgedMarginPct: hedgedPct.get(p.symbolId) ?? DEFAULT_HEDGED_MARGIN_PCT });
      legsByAccount.set(p.account.id, legs);
    }
    byAccount.set(p.account.id, acc);
  }
  for (const [accountId, legs] of legsByAccount) byAccount.get(accountId)!.usedMargin = hedgedUsedMargin(legs);

  return [...byAccount.values()].map((a) => {
    const equity = a.balance.add(a.credit).add(a.floating);
    return {
      accountId: a.accountId,
      accountNumber: a.accountNumber,
      balance: a.balance.toNumber(),
      credit: a.credit.toNumber(),
      floatingPnl: a.floating.toNumber(),
      equity: equity.toNumber(),
      usedMargin: a.usedMargin.toNumber(),
      exposure: a.exposure.toNumber(),
      positionCount: a.positionCount,
      marginCallLevel: a.marginCallLevel.toNumber(),
      stopOutLevel: a.stopOutLevel.toNumber(),
      marginLevel: a.usedMargin.gt(0) ? equity.div(a.usedMargin).mul(100).toNumber() : null,
    };
  });
}

// Phase 0 money-risk patch (docs/ROADMAP.md item 2) -- standard forex
// margin formula, kept identical to engine/risk/src/lib.rs's own
// required_margin (volume * contract_size * price / leverage) so both
// paths agree on what a position costs in margin. See
// lib/margin.test.ts's parity test against that crate's own
// required_margin_standard_lot_1_to_100 fixture.
export function requiredMarginFor(
  volume: Prisma.Decimal,
  contractSize: Prisma.Decimal,
  price: Prisma.Decimal,
  leverage: number
): Prisma.Decimal {
  return volume.mul(contractSize).mul(price).div(leverage);
}

// ---- MT5 hedged margin (2026-09-25) ----
// An account's used margin is no longer a plain sum of per-position margins. Per SYMBOL, the BUY and SELL volume that
// offset each other (the hedged volume) is charged BrokerSymbol.hedgedMarginPct of ONE lot's margin per lot PAIR; only
// the uncovered volume pays full margin. 200 = both legs in full (the behavior before this, and the default), so a
// symbol nobody configured is unchanged.
//
// Canonical formula, per symbol (engine/order-management/src/calc.rs used_margin is the same, operation for
// operation, so the web and the engine agree to the last digit):
//   L = the side with the larger volume (BUY on a tie), S = the other; Ml, Ms = the sum of those positions' full
//   margins (live close-side price x fx rate, exactly as liveUsedMarginFor); l, s = their volumes.
//   covered = s == 0 ? 0 : Ml * s / l            (the larger side's margin on the hedged volume)
//   margin  = (Ml - covered) + (Ms + covered) * pct / 200
// At pct 200 that is exactly Ml + Ms, the plain sum.
export type MarginLeg = {
  /** Positions with the same key hedge each other (the symbol; one account at a time). */
  symbolKey: string;
  side: "BUY" | "SELL";
  volume: Prisma.Decimal;
  /** This position's full margin in the account currency. */
  margin: Prisma.Decimal;
  hedgedMarginPct: Prisma.Decimal;
};

export const DEFAULT_HEDGED_MARGIN_PCT = new Prisma.Decimal(200);

export function hedgedUsedMargin(legs: MarginLeg[]): Prisma.Decimal {
  const bySymbol = new Map<string, { buyVol: Prisma.Decimal; sellVol: Prisma.Decimal; buyMargin: Prisma.Decimal; sellMargin: Prisma.Decimal; pct: Prisma.Decimal }>();
  const zero = new Prisma.Decimal(0);
  for (const leg of legs) {
    const s = bySymbol.get(leg.symbolKey) ?? { buyVol: zero, sellVol: zero, buyMargin: zero, sellMargin: zero, pct: leg.hedgedMarginPct };
    if (leg.side === "BUY") { s.buyVol = s.buyVol.add(leg.volume); s.buyMargin = s.buyMargin.add(leg.margin); }
    else { s.sellVol = s.sellVol.add(leg.volume); s.sellMargin = s.sellMargin.add(leg.margin); }
    bySymbol.set(leg.symbolKey, s);
  }
  let total = zero;
  for (const s of bySymbol.values()) total = total.add(symbolHedgedMargin(s.buyVol, s.buyMargin, s.sellVol, s.sellMargin, s.pct));
  return total;
}

function symbolHedgedMargin(buyVol: Prisma.Decimal, buyMargin: Prisma.Decimal, sellVol: Prisma.Decimal, sellMargin: Prisma.Decimal, pct: Prisma.Decimal): Prisma.Decimal {
  const buyIsLarger = buyVol.gte(sellVol);
  const [l, ml, s, ms] = buyIsLarger ? [buyVol, buyMargin, sellVol, sellMargin] : [sellVol, sellMargin, buyVol, buyMargin];
  if (s.isZero()) return ml.add(ms);
  const covered = ml.mul(s).div(l);
  return ml.sub(covered).add(ms.add(covered).mul(pct).div(200));
}

// 2026-09-05 P0 fix -- the single, unified "how much margin does this
// OPEN position use right now" formula. Before this, three call sites
// each computed it differently: computeAccountMarginSnapshots below and
// lib/risk-monitor.ts's stop-out loop both used the position's CURRENT
// bid regardless of side (a BUY and a SELL were both priced off bid --
// an unintentional inconsistency with how P&L itself is computed, via
// closePriceFor), while checkAccountPreTradeMargin below used each
// position's own frozen OPEN price instead of a live one at all --
// live-quantified to disagree by $54 on 3 real positions at the same
// instant. Live price (not open price) was chosen deliberately: margin
// is meant to reflect an open position's CURRENT market exposure/cost to
// unwind, not what it happened to cost when it opened, and it's what 3 of
// the 4 pre-existing implementations (including WebTrader.tsx's own
// client-side display) already agreed on -- unifying onto open price
// instead would have silently changed what every trader already sees on
// their own dashboard. Side-aware (closePriceFor: bid for BUY, ask for
// SELL) rather than "always bid," for full consistency with how P&L is
// computed everywhere else in this app.
export function liveUsedMarginFor(params: {
  side: "BUY" | "SELL";
  volume: Prisma.Decimal;
  contractSize: Prisma.Decimal;
  bid: Prisma.Decimal;
  ask: Prisma.Decimal;
  leverage: number;
}): Prisma.Decimal {
  const price = closePriceFor(params.side, params.bid, params.ask);
  return requiredMarginFor(params.volume, params.contractSize, price, params.leverage);
}

// Same "would this order push the account below its margin-call level"
// gate as engine/risk/src/lib.rs's check_free_margin -- at
// marginCallLevel=100 (Group.marginCallLevel's own default) this reduces
// to that function's exact free-margin >= required-margin inequality
// (see lib/margin.test.ts). Generalized to an account's own configured
// call level rather than Rust's hardcoded 100, matching the rest of this
// app's convention of group-configurable thresholds (Group.marginCallLevel,
// already read by computeAccountMarginSnapshots above). null = safe to open.
export function checkPreTradeMargin(params: {
  equity: Prisma.Decimal;
  usedMargin: Prisma.Decimal;
  requiredMargin: Prisma.Decimal;
  marginCallLevel: Prisma.Decimal;
}): string | null {
  const projectedUsedMargin = params.usedMargin.add(params.requiredMargin);
  if (projectedUsedMargin.isZero()) return null;
  const projectedLevel = params.equity.div(projectedUsedMargin).mul(100);
  // Stage 2 F3: margin call is `level <= marginCallLevel`, so an order that would land exactly ON the call
  // level would open straight into margin call and is refused too (was lt).
  if (projectedLevel.lte(params.marginCallLevel)) {
    return "INSUFFICIENT_MARGIN";
  }
  return null;
}

// error: "INSUFFICIENT_BALANCE" when the account's balance itself cannot cover the new order's
// margin (nothing / not enough deposited -- the shortfall exists even with no other position
// open), "INSUFFICIENT_MARGIN" when the balance could but the margin already tied up in open
// positions (or the floating loss on them) leaves too little free. The client names them apart.
// "NO_CONVERSION_RATE" (2026-09-23): the new order's symbol, or one already open, is quoted in a currency
// other than the account's and no price exists to convert it with (lib/fx.ts). Margin cannot be known, so
// the order is refused rather than sized as if JPY were USD.
export type PreTradeMarginRejection = { error: "INSUFFICIENT_BALANCE" | "INSUFFICIENT_MARGIN" | "NO_CONVERSION_RATE"; required: string; available: string; balance: string };

// DB-touching wrapper around checkPreTradeMargin above -- computes this
// one account's current equity/used-margin (same per-position formulas
// computeAccountMarginSnapshots uses broker-wide) and evaluates a new
// order about to open at fillPrice against it. Called by every route
// that's about to open a Position for real: app/api/trade/orders/route.ts
// (both the immediate-fill and Smart-Dealer-auto-accept branches) and
// .../orders/[id]/fill/route.ts (a triggered LIMIT/STOP order) -- the
// same two places lib/risk.ts's checkPriceFreshness/checkSlippage
// landed, closing the parallel "no pre-trade check at all" gap for
// margin instead of price. On reject, returns the actual numbers (not
// just a bare code) so the client can show a real "insufficient margin —
// required $X, available $Y" message instead of a bare rejection.
/** symbolId -> BrokerSymbol.hedgedMarginPct for one broker. */
export async function loadHedgedMarginPct(prisma: PrismaClient | Prisma.TransactionClient, brokerId: string): Promise<Map<string, Prisma.Decimal>> {
  const rows = await prisma.brokerSymbol.findMany({ where: { brokerId }, select: { symbolId: true, hedgedMarginPct: true } });
  return new Map(rows.map((r) => [r.symbolId, r.hedgedMarginPct]));
}

/** One account's live margin state: equity (balance + credit + floating P/L, account currency) and hedged used
 *  margin, with the same per-position formulas the pre-trade gate and the risk monitor use. `null` = a position's
 *  quote currency (or one of `extraQuoteCurrencies`) has no conversion rate to the account currency. */
export type AccountMarginState = {
  account: { balance: Prisma.Decimal; credit: Prisma.Decimal; currency: string; brokerId: string };
  equity: Prisma.Decimal;
  usedMargin: Prisma.Decimal;
  legs: MarginLeg[];
  pctFor: (symbolId: string) => Prisma.Decimal;
  rateFor: (quoteCurrency: string) => Prisma.Decimal | null;
  openPositions: number;
};

// `brokerId` (latency fix 1, 2026-09-26): a caller that already knows it lets the hedged-% read run together with the
// account + positions reads instead of after them.
export async function loadAccountMarginState(
  prisma: PrismaClient | Prisma.TransactionClient,
  accountId: string,
  leverage: number,
  extraQuoteCurrencies: string[] = [],
  brokerId?: string
): Promise<AccountMarginState | null> {
  const [account, positions, hedgedPctKnownBroker] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true, credit: true, currency: true, brokerId: true } }),
    prisma.position.findMany({
      where: { accountId, status: "OPEN" },
      select: { side: true, volume: true, openPrice: true, symbolId: true, symbol: { select: { name: true, contractSize: true, quoteCurrency: true } } },
    }),
    brokerId ? loadHedgedMarginPct(prisma, brokerId) : Promise.resolve(null),
  ]);
  // a SELL is valued at the account's ask (lib/ask-markup.ts); resolved only when a SELL is open (no query otherwise)
  const askRulesP = loadSellAskRules(prisma, positions.map((p) => ({ accountId, symbolId: p.symbolId, side: p.side })));
  const hedgedPct = hedgedPctKnownBroker && account.brokerId === brokerId ? hedgedPctKnownBroker : await loadHedgedMarginPct(prisma, account.brokerId);
  const pctFor = (symbolId: string) => hedgedPct.get(symbolId) ?? DEFAULT_HEDGED_MARGIN_PCT;

  const [priceBySymbol, fx, askRules] = await Promise.all([
    getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]),
    loadFxLookup(prisma, [...extraQuoteCurrencies.map((q) => [q, account.currency] as const), ...positions.map((p) => [p.symbol.quoteCurrency, account.currency] as const)]),
    askRulesP,
  ]);
  // Every figure below is quote currency x rate = account currency (lib/fx.ts).
  const rateFor = (quoteCurrency: string) => conversionRate(quoteCurrency, account.currency, fx);
  const positionRates = positions.map((p) => rateFor(p.symbol.quoteCurrency));
  if (positionRates.some((r) => r == null) || extraQuoteCurrencies.some((q) => rateFor(q) == null)) return null;

  // 2026-09-05 P0 fix: this used to always price existing positions'
  // margin off their own frozen openPrice, the one outlier convention
  // among four implementations (see liveUsedMarginFor's own comment) --
  // now uses the same live, side-aware price as everywhere else,
  // falling back to openPrice only for a symbol with no fresh live price
  // right now (the same "can't get worse than before" fallback, never
  // silently dropping a position's margin contribution during a feed gap).
  // Stage 2 F1 (credit Model A): the client can trade on credit, so it counts toward the equity this order is
  // checked against (BEHAVIOR CHANGE 2026-09-24; it used to start from the balance alone).
  let equity = account.balance.add(account.credit);
  const legs: MarginLeg[] = [];
  for (const [i, p] of positions.entries()) {
    const rate = positionRates[i]!;
    const live = priceBySymbol.get(p.symbol.name);
    let margin: Prisma.Decimal;
    if (live) {
      const ask = valuationAsk(askRules, { accountId, symbolId: p.symbolId, side: p.side }, live.bid, live.ask);
      const currentPrice = closePriceFor(p.side, live.bid, ask);
      margin = liveUsedMarginFor({ side: p.side, volume: p.volume, contractSize: p.symbol.contractSize, bid: live.bid, ask, leverage }).mul(rate);
      equity = equity.add(
        computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).mul(rate)
      );
    } else {
      margin = requiredMarginFor(p.volume, p.symbol.contractSize, p.openPrice, leverage).mul(rate);
    }
    legs.push({ symbolKey: p.symbolId, side: p.side, volume: p.volume, margin, hedgedMarginPct: pctFor(p.symbolId) });
  }
  return { account, equity, usedMargin: hedgedUsedMargin(legs), legs, pctFor, rateFor, openPositions: positions.length };
}

export async function checkAccountPreTradeMargin(
  prisma: PrismaClient,
  params: {
    accountId: string;
    leverage: number;
    marginCallLevel: Prisma.Decimal;
    newOrderContractSize: Prisma.Decimal;
    newOrderVolume: Prisma.Decimal;
    newOrderFillPrice: Prisma.Decimal;
    newOrderQuoteCurrency: string;
    /** Hedged margin (2026-09-25): the new order's side and symbol decide how much of it offsets open positions. */
    newOrderSide: "BUY" | "SELL";
    newOrderSymbolId: string;
  }
): Promise<PreTradeMarginRejection | null> {
  const state = await loadAccountMarginState(prisma, params.accountId, params.leverage, [params.newOrderQuoteCurrency]);
  if (!state) {
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { balance: true } });
    return { error: "NO_CONVERSION_RATE", required: "-", available: "-", balance: acc.balance.toFixed(2) };
  }
  return evaluatePreTradeMargin(state, params);
}

/** The pre-trade gate on an already loaded margin state (loadAccountMarginState with the order's quote currency in
 *  `extraQuoteCurrencies`), so a route can load the state in parallel with its other reads and apply the fill price
 *  afterwards. The rule is checkAccountPreTradeMargin's, unchanged. */
export function evaluatePreTradeMargin(
  state: AccountMarginState,
  params: {
    leverage: number;
    marginCallLevel: Prisma.Decimal;
    newOrderContractSize: Prisma.Decimal;
    newOrderVolume: Prisma.Decimal;
    newOrderFillPrice: Prisma.Decimal;
    newOrderQuoteCurrency: string;
    newOrderSide: "BUY" | "SELL";
    newOrderSymbolId: string;
  }
): PreTradeMarginRejection | null {
  const { account, equity, usedMargin, legs, pctFor } = state;
  const newOrderRate = state.rateFor(params.newOrderQuoteCurrency)!;

  const newOrderFullMargin = requiredMarginFor(params.newOrderVolume, params.newOrderContractSize, params.newOrderFillPrice, params.leverage).mul(newOrderRate);
  const usedMarginAfter = hedgedUsedMargin([
    ...legs,
    { symbolKey: params.newOrderSymbolId, side: params.newOrderSide, volume: params.newOrderVolume, margin: newOrderFullMargin, hedgedMarginPct: pctFor(params.newOrderSymbolId) },
  ]);
  // MT5: an order that does not increase the used margin (it hedges an open position at a hedged margin % below 200)
  // is always allowed, whatever the level -- it can only make the account safer.
  if (usedMarginAfter.lte(usedMargin)) return null;
  const requiredMargin = usedMarginAfter.sub(usedMargin);
  const rejectCode = checkPreTradeMargin({ equity, usedMargin, requiredMargin, marginCallLevel: params.marginCallLevel });
  if (!rejectCode) return null;
  // "INSUFFICIENT_BALANCE" = the funds (balance + credit) could not carry this order's margin even with nothing
  // else open; otherwise open positions are what leave too little free
  const funds = account.balance.add(account.credit);
  const balanceShort = funds.lte(0) || funds.lt(requiredMargin);
  return {
    error: balanceShort ? "INSUFFICIENT_BALANCE" : "INSUFFICIENT_MARGIN",
    required: requiredMargin.toFixed(2),
    available: equity.sub(usedMargin).toFixed(2),
    balance: account.balance.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Money OUT of an account (audit 2026-09-24, money): a withdrawal, a transfer out, a debit adjustment.
// Refused when afterwards the balance would be below 0, or -- with positions open -- the margin level would be at or
// below the group's margin-call level (the same line a new order may not cross, checkPreTradeMargin). A debit never
// pushes an account with open positions into margin call; with nothing open only the balance floor applies.
// `balance` may be passed in by a caller that already holds the row lock (lib/account-lock.ts), so the check runs on
// the locked value, not a stale read.
// ---------------------------------------------------------------------------
export type BalanceDebitRejection = {
  error: "BALANCE_BELOW_ZERO" | "INSUFFICIENT_FREE_MARGIN" | "NO_CONVERSION_RATE";
  message: string;
  balanceAfter: string;
  freeMarginAfter: string | null;
};

export function evaluateBalanceDebit(params: {
  balanceAfter: Prisma.Decimal;
  equityAfter: Prisma.Decimal;
  usedMargin: Prisma.Decimal;
  marginCallLevel: Prisma.Decimal;
}): BalanceDebitRejection | null {
  if (params.balanceAfter.lt(0)) {
    return { error: "BALANCE_BELOW_ZERO", message: `balance would go below 0 (${params.balanceAfter.toFixed(2)})`, balanceAfter: params.balanceAfter.toFixed(2), freeMarginAfter: null };
  }
  if (params.usedMargin.isZero()) return null;
  const levelAfter = params.equityAfter.div(params.usedMargin).mul(100);
  if (levelAfter.lte(params.marginCallLevel)) {
    const free = params.equityAfter.sub(params.usedMargin);
    return {
      error: "INSUFFICIENT_FREE_MARGIN",
      message: `open positions need the margin: the margin level would fall to ${levelAfter.toFixed(0)}% (margin call ${params.marginCallLevel.toFixed(0)}%)`,
      balanceAfter: params.balanceAfter.toFixed(2),
      freeMarginAfter: free.toFixed(2),
    };
  }
  return null;
}

export async function checkBalanceDebit(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: { accountId: string; amount: Prisma.Decimal; balance?: Prisma.Decimal }
): Promise<BalanceDebitRejection | null> {
  const acc = await prisma.account.findUniqueOrThrow({ where: { id: params.accountId }, select: { leverage: true, balance: true, group: { select: { marginCallLevel: true } } } });
  const balance = params.balance ?? acc.balance;
  const balanceAfter = balance.sub(params.amount);
  const state = await loadAccountMarginState(prisma, params.accountId, acc.leverage);
  if (!state) {
    return { error: "NO_CONVERSION_RATE", message: "an open position cannot be valued in the account currency right now, try again later", balanceAfter: balanceAfter.toFixed(2), freeMarginAfter: null };
  }
  // equity was computed from the stored balance; move it by the difference to the locked one, then by the debit
  const equityAfter = state.equity.add(balance.sub(state.account.balance)).sub(params.amount);
  return evaluateBalanceDebit({ balanceAfter, equityAfter, usedMargin: state.usedMargin, marginCallLevel: acc.group?.marginCallLevel ?? new Prisma.Decimal(100) });
}
