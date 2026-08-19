import { Prisma, PrismaClient, TradingMode } from "@prisma/client";
import type { OrderSide } from "@/lib/trading";

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

// Zero sessions = always tradable -- same null/empty-means-unlimited
// convention as every other check here (maxExposure, maxDailyLoss, ...).
// `now` is injected (not read internally) so this stays a pure function,
// same testability reason the rest of this file's checks take their
// inputs as plain values instead of reaching for the DB/clock themselves.
export function checkTradingSession(
  sessions: { dayOfWeek: number; openTime: string; closeTime: string }[],
  now: Date
): string | null {
  if (sessions.length === 0) return null;
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
  return open ? null : "this symbol is outside its trading session hours right now";
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
