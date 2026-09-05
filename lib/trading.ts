import { Prisma } from "@prisma/client";

export type OrderSide = "BUY" | "SELL";

// Mirrors the client-side validation in vyx-webtrader.html — re-checked
// here because "authorization/validation must be enforced server-side,
// never trust a frontend check alone."
//
// `digits`/`stopLevel` are optional so every pre-existing caller (which
// only ever checked side-correctness) keeps compiling and behaving exactly
// as before. When both are passed, this also enforces the MT4/5 "stop
// level": an SL/TP can't sit closer than `stopLevel` POINTS (the symbol's
// own smallest price increment, 10^-digits) from the reference price --
// needed by the chart's draggable SL/TP feature so a drag can't produce a
// price the server would reject anyway. stopLevel <= 0 means unrestricted.
export function validateSlTp(params: {
  side: OrderSide;
  referencePrice: Prisma.Decimal | number | string;
  slPrice?: Prisma.Decimal | number | string | null;
  tpPrice?: Prisma.Decimal | number | string | null;
  digits?: number;
  stopLevel?: number;
}): string | null {
  const ref = new Prisma.Decimal(params.referencePrice);
  const minDistance =
    params.stopLevel && params.stopLevel > 0 && params.digits != null
      ? new Prisma.Decimal(10).pow(-params.digits).mul(params.stopLevel)
      : null;

  if (params.slPrice != null) {
    const sl = new Prisma.Decimal(params.slPrice);
    if (params.side === "BUY" && sl.gte(ref)) return "SL must be below the reference price for a BUY";
    if (params.side === "SELL" && sl.lte(ref)) return "SL must be above the reference price for a SELL";
    if (minDistance && ref.sub(sl).abs().lt(minDistance)) return `SL must be at least ${minDistance} away from the current price`;
  }
  if (params.tpPrice != null) {
    const tp = new Prisma.Decimal(params.tpPrice);
    if (params.side === "BUY" && tp.lte(ref)) return "TP must be above the reference price for a BUY";
    if (params.side === "SELL" && tp.gte(ref)) return "TP must be below the reference price for a SELL";
    if (minDistance && tp.sub(ref).abs().lt(minDistance)) return `TP must be at least ${minDistance} away from the current price`;
  }
  return null;
}

// Same "distance from a reference price" rule as above, applied to a
// pending order's own entry price against the CURRENT market price (not
// the order's requested price) -- the MT4/5 rule for placing/editing a
// LIMIT/STOP: it must sit at least stopLevel points away from where the
// market actually is right now, on the correct side for its type.
export function validatePendingPriceDistance(params: {
  type: "LIMIT" | "STOP";
  side: OrderSide;
  entryPrice: Prisma.Decimal | number | string;
  marketPrice: Prisma.Decimal | number | string;
  digits: number;
  stopLevel: number;
}): string | null {
  if (!params.stopLevel || params.stopLevel <= 0) return null;
  const entry = new Prisma.Decimal(params.entryPrice);
  const market = new Prisma.Decimal(params.marketPrice);
  const minDistance = new Prisma.Decimal(10).pow(-params.digits).mul(params.stopLevel);
  if (entry.sub(market).abs().lt(minDistance)) {
    return `Price must be at least ${minDistance} away from the current market price`;
  }
  return null;
}

// MT4/5 directional rule for a resting LIMIT/STOP, checked both at
// placement and at entry-price modify (2026-09-05 audit finding -- until
// now nothing validated this at all: a "BUY LIMIT" above market or a
// "SELL STOP" above market went through unrejected, live-confirmed twice
// during Section A). `marketPrice` must be the side-appropriate live
// reference (ask for BUY, bid for SELL -- the same side this order would
// actually fill against), fetched server-side by the caller, never a
// client-supplied value -- same "server is the price authority" rule
// every other price check in this app already follows.
export function validatePendingOrderDirection(params: {
  type: "LIMIT" | "STOP";
  side: OrderSide;
  entryPrice: Prisma.Decimal | number | string;
  marketPrice: Prisma.Decimal | number | string;
}): string | null {
  const entry = new Prisma.Decimal(params.entryPrice);
  const market = new Prisma.Decimal(params.marketPrice);
  const sideLabel = params.side === "BUY" ? "Buy" : "Sell";
  const typeLabel = params.type === "LIMIT" ? "Limit" : "Stop";
  // BUY LIMIT (buy cheaper later) and SELL STOP (sell on a breakdown)
  // both require the entry to sit BELOW the current price; SELL LIMIT
  // (sell higher later) and BUY STOP (buy on a breakout) both require it
  // ABOVE.
  const mustBeBelow = (params.side === "BUY" && params.type === "LIMIT") || (params.side === "SELL" && params.type === "STOP");
  if (mustBeBelow && entry.gte(market)) {
    return `A ${sideLabel} ${typeLabel} must be below the current price`;
  }
  if (!mustBeBelow && entry.lte(market)) {
    return `A ${sideLabel} ${typeLabel} must be above the current price`;
  }
  return null;
}

export function computeRealizedPnl(params: {
  side: OrderSide;
  openPrice: Prisma.Decimal;
  closePrice: Prisma.Decimal | number | string;
  volume: Prisma.Decimal;
  contractSize: Prisma.Decimal;
}): Prisma.Decimal {
  const closePrice = new Prisma.Decimal(params.closePrice);
  const diff = params.side === "BUY" ? closePrice.sub(params.openPrice) : params.openPrice.sub(closePrice);
  return diff.mul(params.contractSize).mul(params.volume);
}
