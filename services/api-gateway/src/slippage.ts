// The broker's slippage cap, ported from the web's `lib/slippage-cap.ts` so a close through this
// Gateway refuses exactly what the web's close route refuses.
//
// WHY A PORT AND NOT AN IMPORT: that module imports `Prisma` from @prisma/client for its Decimal, and
// this service deliberately has no Prisma client (ADR-002: raw `pg`). Prisma.Decimal IS decimal.js, so
// the arithmetic here is the same arithmetic -- same rounding mode, same precision. The rules it
// encodes are money rules, so they are kept line-for-line rather than re-derived:
//
//   1. only ADVERSE slippage counts -- a fill better than the client's price always fills;
//   2. the broker sets one base on XAUUSD; every other symbol gets the same FRACTION of its own price,
//      unless that symbol has its own `BrokerSymbol.maxSlippagePoints`;
//   3. the trader's own max can only TIGHTEN the cap (the effective cap is the smaller of the two).
//
// If `lib/slippage-cap.ts` changes, this file has to change with it. The parity test
// (`slippage-parity.test.ts`) exists to make that failure loud rather than silent.

import { Decimal } from "decimal.js";

export const SLIPPAGE_BASE_SYMBOL = "XAUUSD";
const BASE_DIGITS = 2; // the base is in XAUUSD points (0.01 USD)

export type SlippageCapSettings = {
  slippageCapXauPoints: Decimal | null;
  slippageCapRefPrice: Decimal | null;
};

/** The symbol's cap in its own points, or null when the broker has no cap. Always at least 1 point. */
export function symbolSlippageCapPoints(
  broker: SlippageCapSettings,
  symbol: { name: string; digits: number; maxSlippagePoints?: Decimal | null },
  price: Decimal
): Decimal | null {
  if (symbol.maxSlippagePoints != null) return new Decimal(symbol.maxSlippagePoints);
  const base = broker.slippageCapXauPoints;
  if (base == null) return null;
  if (symbol.name === SLIPPAGE_BASE_SYMBOL) return new Decimal(base);
  const ref = broker.slippageCapRefPrice;
  if (ref == null || ref.lte(0) || price.lte(0)) return new Decimal(base);
  // the base as a fraction of the gold price (30 points at 4000 = 0.0075 %), applied to this symbol's price
  const fraction = new Decimal(base).mul(new Decimal(10).pow(-BASE_DIGITS)).div(ref);
  const points = fraction.mul(price).mul(new Decimal(10).pow(symbol.digits)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return Decimal.max(points, 1);
}

/** How many points WORSE than requested the fill is for the client (0 when equal or better). `side` is the
 *  trade being EXECUTED: a close of a BUY position sells, so lower is worse. */
export function adverseSlippagePoints(side: "BUY" | "SELL", requested: Decimal | string, fill: Decimal, digits: number): Decimal {
  const diff = side === "BUY" ? fill.sub(new Decimal(requested)) : new Decimal(requested).sub(fill);
  const points = diff.mul(new Decimal(10).pow(digits));
  return points.gt(0) ? points : new Decimal(0);
}

/** The cap in force: the smaller of the trader's own value (points; null / "unlimited" = none) and the symbol's cap. */
export function effectiveCapPoints(traderPoints: string | null | undefined, symbolCap: Decimal | null): Decimal | null {
  let trader: Decimal | null = null;
  if (traderPoints != null && traderPoints !== "" && traderPoints !== "unlimited") {
    try {
      trader = new Decimal(traderPoints);
    } catch {
      trader = null;
    }
  }
  if (trader == null) return symbolCap;
  if (symbolCap == null) return trader;
  return Decimal.min(trader, symbolCap);
}

export type SlippageVerdict = { over: false } | { over: true; adversePoints: Decimal; capPoints: Decimal };

export function slippageVerdict(p: {
  side: "BUY" | "SELL";
  requested: Decimal | string;
  fill: Decimal;
  digits: number;
  capPoints: Decimal | null;
}): SlippageVerdict {
  if (p.capPoints == null) return { over: false };
  const adversePoints = adverseSlippagePoints(p.side, p.requested, p.fill, p.digits);
  return adversePoints.gt(p.capPoints) ? { over: true, adversePoints, capPoints: p.capPoints } : { over: false };
}

/** The trader's own cap in points, from either spelling. Points wins when both are sent, same as the web. */
export function traderSlippagePoints(
  body: { maxSlippagePoints?: unknown; maxSlippagePips?: unknown },
  digits: number
): string | null {
  if (body.maxSlippagePoints != null) return String(body.maxSlippagePoints);
  if (body.maxSlippagePips == null) return null;
  const pips = String(body.maxSlippagePips);
  if (pips === "unlimited") return pips;
  try {
    // a pip is 10 points on a 3/5-digit symbol, 1 point otherwise -- lib/risk.ts's pipSize convention
    const perPip = digits === 3 || digits === 5 ? 10 : 1;
    return new Decimal(pips).mul(perPip).toString();
  } catch {
    return null;
  }
}
