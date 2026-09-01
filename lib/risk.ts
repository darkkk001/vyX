import { Prisma, PrismaClient, TradingMode } from "@prisma/client";
import type { OrderSide } from "@/lib/trading";
import { pipSize } from "@/lib/group-pricing";

type Db = PrismaClient | Prisma.TransactionClient;

// Broker-wide emergency halt -- see Broker.tradingHaltedAt's own schema
// comment. Existing open positions are untouched; this only blocks new
// orders/positions.
export function checkTradingHalted(broker: { tradingHaltedAt: Date | null }): string | null {
  if (broker.tradingHaltedAt) return "trading is halted for this broker";
  return null;
}

// BOTH (default) never blocks. BUY_ONLY/SELL_ONLY reject the disallowed
// side even when the symbol is otherwise enabled -- a stronger
// restriction than `enabled`, not a replacement for it.
export function checkSymbolTradingMode(tradingMode: TradingMode, side: OrderSide): string | null {
  if (tradingMode === "BUY_ONLY" && side !== "BUY") return "this symbol is buy-only right now";
  if (tradingMode === "SELL_ONLY" && side !== "SELL") return "this symbol is sell-only right now";
  return null;
}

// Null = no override, falls through to the existing per-symbol
// minLot/maxLot check unchanged (that one lives inline in each order
// route, not here). Group.maxLotSize is a per-order cap, not cumulative.
export function checkGroupMaxLot(volume: Prisma.Decimal, groupMaxLot: Prisma.Decimal | null): string | null {
  if (groupMaxLot == null) return null;
  if (volume.gt(groupMaxLot)) {
    return `volume exceeds this account's group max lot size of ${groupMaxLot}`;
  }
  return null;
}

// Same shape/semantics as checkSymbolTradingMode, applied at the
// account's group level instead of the symbol level -- both can block
// independently.
export function checkGroupTradingRestriction(restriction: TradingMode, side: OrderSide): string | null {
  if (restriction === "BUY_ONLY" && side !== "BUY") return "this account's group is buy-only right now";
  if (restriction === "SELL_ONLY" && side !== "SELL") return "this account's group is sell-only right now";
  return null;
}

// Opt-in -- restrictSymbols defaults to false on every group (see
// Group.restrictSymbols's own schema comment), in which case this never
// blocks anything, identical to before this check existed. Only once a
// broker admin explicitly turns it on for a group does that group's
// GroupSymbol rows become an allowlist instead of being ignored.
export function checkGroupAllowedSymbol(
  restrictSymbols: boolean,
  allowedSymbolIds: string[],
  symbolId: string
): string | null {
  if (!restrictSymbols) return null;
  if (!allowedSymbolIds.includes(symbolId)) {
    return "this symbol is not enabled for this account's group";
  }
  return null;
}

// Volume must be minLot plus a whole number of lotStep increments (not
// just within the min/max range, which both live order routes already
// check separately). Decimal math throughout -- never Number/float.
export function checkLotStep(volume: Prisma.Decimal, minLot: Prisma.Decimal, lotStep: Prisma.Decimal): string | null {
  if (lotStep.lte(0)) return null; // misconfigured lotStep -- don't hard-block trading over it
  const remainder = volume.sub(minLot).mod(lotStep);
  if (!remainder.isZero()) {
    return `volume must be ${minLot} plus a multiple of ${lotStep}`;
  }
  return null;
}

// The two symbols this platform lists that trade continuously (see
// lib/market-simulator.ts's SYMBOL_DEFS) -- same static allowlist
// engine/market-data/src/gap_fill.rs's own is_continuously_traded()
// keeps, for the same reason stated there: no live per-symbol
// category/session lookup exists in that crate, so it's a hardcoded list
// kept in sync by hand. Here in the legacy TS path a real lookup DOES
// exist (BrokerSymbol.symbol.category), so this only needs to be the
// crypto-detection rule for symbols that reach checkTradingSession
// without that context already resolved -- kept name-based to match the
// Rust side exactly, one rule expressed twice, not two different rules.
function isContinuouslyTraded(symbolName: string): boolean {
  return symbolName === "BTCUSD" || symbolName === "ETHUSD";
}

// The standard global FX/metals weekend close every major venue observes,
// used as the DEFAULT session when a BrokerSymbol has no admin-configured
// TradingSession rows -- see that model's own schema comment ("zero rows
// = always tradable") and this incident: because literally no broker had
// ever configured session rows for any symbol, checkTradingSession below
// was a no-op for the entire platform, and a MARKET order filled XAUUSD
// on a Saturday. "Zero rows = always tradable" was the wrong default for
// a symbol nobody has actively opted OUT of a real market close for.
//
// Mirrors engine/market-data/src/gap_fill.rs's market_closed() exactly --
// same DST-safe Friday 21:00 UTC cutoff (that file's own comment explains
// why 21:00 not 22:00: NY close is 21:00 UTC in winter/EST, 22:00 in
// summer/EDT, and 21:00 is the earlier, always-safe bound). Not literally
// shared code -- Rust and this Next.js app don't share a build -- but
// this is the ONE rule both are meant to implement; keep them in sync by
// hand if this ever changes.
export function isDefaultFxSessionClosed(now: Date): boolean {
  const day = now.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const hour = now.getUTCHours();
  if (day === 6) return true; // Saturday: closed all day
  if (day === 5 && hour >= 21) return true; // Friday >= 21:00 UTC
  if (day === 0 && hour < 22) return true; // Sunday < 22:00 UTC
  return false;
}

// `sessions` (admin-configured TradingSession rows) take priority when
// present -- an explicit configuration always wins over the default.
// Zero configured rows now falls through to isDefaultFxSessionClosed
// instead of "always tradable" (see that function's own comment for why).
// symbolName is required, not optional, specifically so a caller can't
// forget it and silently get the old always-open behavior back.
//
// Returns the bare machine-readable code "MARKET_CLOSED" (same
// convention as checkPriceFreshness's PRICE_STALE below) rather than a
// sentence -- the client renders its own friendly copy for this specific
// code (see WebTrader.tsx's handleOrderError); every other caller of this
// function (backoffice dealing-queue/positions/mirror routes) is
// staff-facing, where the bare code is precise enough to act on as-is.
export function checkTradingSession(
  sessions: { dayOfWeek: number; openTime: string; closeTime: string }[],
  now: Date,
  symbolName: string
): string | null {
  if (isContinuouslyTraded(symbolName)) return null;

  if (sessions.length === 0) {
    return isDefaultFxSessionClosed(now) ? "MARKET_CLOSED" : null;
  }

  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const open = sessions.some((s) => {
    if (s.dayOfWeek !== day) return false;
    return minutes >= toMinutes(s.openTime) && minutes < toMinutes(s.closeTime);
  });
  return open ? null : "MARKET_CLOSED";
}

// Null maxOpenPositions = no limit -- Broker.maxOpenPositionsPerAccount
// has existed since migration 20260817000000_exposure_limits but this is
// its first real read on any live path (previously only engine/risk
// read it, and no live route calls the Rust engine -- see
// docs/architecture.md's 2026-08-18 status re-check).
export async function checkMaxOpenPositions(
  db: Db,
  accountId: string,
  maxOpenPositions: number | null
): Promise<string | null> {
  if (maxOpenPositions == null) return null;
  const openCount = await db.position.count({ where: { accountId, status: "OPEN" } });
  if (openCount >= maxOpenPositions) {
    return `account already has the maximum ${maxOpenPositions} open position(s)`;
  }
  return null;
}

// Null maxExposure = no limit -- BrokerSymbol.maxExposure's own schema
// comment: "Max total open volume (lots) an account may hold in this
// symbol at once, summed across all its open positions." First real
// read on any live path, same gap as checkMaxOpenPositions.
export async function checkSymbolExposure(
  db: Db,
  accountId: string,
  symbolId: string,
  orderVolume: Prisma.Decimal,
  maxExposure: Prisma.Decimal | null
): Promise<string | null> {
  if (maxExposure == null) return null;
  const agg = await db.position.aggregate({
    where: { accountId, symbolId, status: "OPEN" },
    _sum: { volume: true },
  });
  const current = agg._sum.volume ?? new Prisma.Decimal(0);
  if (current.add(orderVolume).gt(maxExposure)) {
    return `order would exceed this symbol's max exposure of ${maxExposure} lots for this account`;
  }
  return null;
}

// Null totalExposureLimit = no limit -- sum of open volume across every
// symbol for this broker (not per-account, unlike checkSymbolExposure).
export async function checkBrokerExposure(
  db: Db,
  brokerId: string,
  orderVolume: Prisma.Decimal,
  totalExposureLimit: Prisma.Decimal | null
): Promise<string | null> {
  if (totalExposureLimit == null) return null;
  const agg = await db.position.aggregate({
    where: { brokerId, status: "OPEN" },
    _sum: { volume: true },
  });
  const current = agg._sum.volume ?? new Prisma.Decimal(0);
  if (current.add(orderVolume).gt(totalExposureLimit)) {
    return `order would exceed this broker's total exposure limit of ${totalExposureLimit} lots`;
  }
  return null;
}

// POST /api/trade/orders already has its own inline, freshness-only
// version of this for MARKET-order open (a live tick must exist for the
// symbol, no check on how close the client's price is to it -- see that
// route's own module comment on why prices are still client-simulated
// for now). Position close and pending-order fill had **no check at
// all** -- the two places that actually realize P&L to the account
// balance, meaning an authenticated trader could close any position (or
// fill any resting order) at literally any price via a direct API call,
// minting arbitrary profit. This is deliberately stricter than the
// open-side check: not just "a live tick exists" but "the requested
// price is within a generous band of it" -- generous because prices here
// are still client-simulated, not a real matching engine, so this is a
// floor against outright fabrication, not a tight spread match.
const LIVE_PRICE_MAX_AGE_MS = 15_000;
const PRICE_DEVIATION_TOLERANCE_PCT = 2;

// Split so POST /api/trade/orders -- which already fetches LivePrice
// itself for the Smart Dealer diffPct calc a few lines later -- can reuse
// that one query instead of a second round-trip. checkLiveMarketPrice
// below is the fetch-it-yourself convenience wrapper for the two callers
// that don't already have a LivePrice row in hand (close, fill).
export function evaluateLiveMarketPrice(
  livePrice: { bid: Prisma.Decimal; ask: Prisma.Decimal; updatedAt: Date } | null,
  symbolName: string,
  clientPrice: Prisma.Decimal | string
): string | null {
  if (!livePrice || Date.now() - livePrice.updatedAt.getTime() > LIVE_PRICE_MAX_AGE_MS) {
    return "no live feed for this symbol";
  }
  const price = new Prisma.Decimal(clientPrice);
  const mid = livePrice.bid.add(livePrice.ask).div(2);
  const diffPct = price.sub(mid).abs().div(mid).mul(100);
  if (diffPct.gt(PRICE_DEVIATION_TOLERANCE_PCT)) {
    return `price is too far from the current market price for ${symbolName}`;
  }
  return null;
}

export async function checkLiveMarketPrice(
  db: Db,
  symbolName: string,
  clientPrice: Prisma.Decimal | string
): Promise<string | null> {
  const livePrice = await db.livePrice.findUnique({ where: { symbol: symbolName } });
  return evaluateLiveMarketPrice(livePrice, symbolName, clientPrice);
}

// Phase 0 money-risk patch (docs/ROADMAP.md) -- the server, not the
// client, is now the execution-price authority for MARKET fills (see
// app/api/trade/orders/route.ts and .../orders/[id]/fill/route.ts's
// rewritten module comments). This is a tighter, purpose-built gate than
// evaluateLiveMarketPrice's own 15s/2% sanity check above: 3s is how
// fresh a tick must be to be trusted as *the* fill price, not just
// evidence that a feed exists at all. Returns the bare machine-readable
// code (not a sentence) so the client can branch on it -- see
// components/webtrader/WebTrader.tsx's placeOrder, which shows a
// price-moved retry toast specifically for this code.
const FILL_PRICE_MAX_AGE_MS = 3_000;

export function checkPriceFreshness(livePrice: { updatedAt: Date } | null): string | null {
  if (!livePrice || Date.now() - livePrice.updatedAt.getTime() > FILL_PRICE_MAX_AGE_MS) {
    return "PRICE_STALE";
  }
  return null;
}

// The client's submitted price is no longer an executable price (see
// above) -- it's the price the client saw when it clicked Buy/Sell/set a
// pending-order trigger, now used only as a tolerance anchor: how far the
// server's own fill price is allowed to have moved from what the client
// expected before the order gets rejected instead of silently filled at a
// worse price. maxSlippagePips is client-supplied (WebTrader doesn't send
// one today, so this always falls back to the default) so a future UI
// can let a trader tighten or loosen it per order.
const DEFAULT_MAX_SLIPPAGE_PIPS = new Prisma.Decimal(5);

export function checkSlippage(params: {
  clientReferencePrice: Prisma.Decimal | string;
  serverFillPrice: Prisma.Decimal;
  maxSlippagePips: Prisma.Decimal | number | string | null | undefined;
  digits: number;
}): string | null {
  const maxPips =
    params.maxSlippagePips != null ? new Prisma.Decimal(params.maxSlippagePips) : DEFAULT_MAX_SLIPPAGE_PIPS;
  const tolerance = maxPips.mul(pipSize(params.digits));
  const deviation = params.serverFillPrice.sub(new Prisma.Decimal(params.clientReferencePrice)).abs();
  if (deviation.gt(tolerance)) {
    return "SLIPPAGE_EXCEEDED";
  }
  return null;
}

// Null maxDailyLoss = no limit. Blocks new orders once today's realized
// P&L (SUM of TRADE_PNL Transaction rows since local midnight) is
// already at or below -maxDailyLoss. Existing open positions are
// untouched -- this only blocks new trading for the rest of the day.
// On-the-fly aggregate query, no new ledger/running-total table needed.
export async function checkMaxDailyLoss(
  db: Db,
  accountId: string,
  maxDailyLoss: Prisma.Decimal | null
): Promise<string | null> {
  if (maxDailyLoss == null) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const agg = await db.transaction.aggregate({
    where: { accountId, type: "TRADE_PNL", createdAt: { gte: startOfToday } },
    _sum: { amount: true },
  });
  const realizedToday = agg._sum.amount ?? new Prisma.Decimal(0);
  if (realizedToday.lte(maxDailyLoss.neg())) {
    return `daily loss limit of ${maxDailyLoss} reached for this account -- try again tomorrow`;
  }
  return null;
}
