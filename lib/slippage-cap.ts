import { Prisma } from "@prisma/client";

// Slippage cap per broker (owner 2026-10-26, docs: C:\vyx\handoff\slippage-cap-design.md, approved):
//   1. only ADVERSE slippage counts: a fill better than the price the client sent always fills;
//   2. the broker sets one base on XAUUSD (default 30 points); every other symbol gets the same fraction of its own
//      price, unless the broker set that symbol's own cap (BrokerSymbol.maxSlippagePoints);
//   3. over the cap the order is requoted at the live price (Broker.slippageAction REQUOTE, the default) or refused (REJECT).
// The trader's own SLIPPAGE MAX can only tighten it: the effective cap is the smaller of the two.
// It applies to every market fill: the direct fill, the Smart Dealer's auto-accept, a dealer's accept at market, a close.

export const SLIPPAGE_BASE_SYMBOL = "XAUUSD";
const BASE_DIGITS = 2; // the base is in XAUUSD points (0.01 USD)

export type SlippageCapSettings = {
  slippageCapXauPoints: Prisma.Decimal | null;
  slippageCapRefPrice: Prisma.Decimal | null;
};

/** The symbol's cap in its own points, or null when the broker has no cap. `price` is the symbol's live price (the
 *  fill's own reference), used only to derive a symbol without its own value. Always at least 1 point. */
export function symbolSlippageCapPoints(
  broker: SlippageCapSettings,
  symbol: { name: string; digits: number; maxSlippagePoints?: Prisma.Decimal | null },
  price: Prisma.Decimal
): Prisma.Decimal | null {
  if (symbol.maxSlippagePoints != null) return new Prisma.Decimal(symbol.maxSlippagePoints);
  const base = broker.slippageCapXauPoints;
  if (base == null) return null;
  if (symbol.name === SLIPPAGE_BASE_SYMBOL) return new Prisma.Decimal(base);
  const ref = broker.slippageCapRefPrice;
  if (ref == null || ref.lte(0) || price.lte(0)) return new Prisma.Decimal(base);
  // the base as a fraction of the gold price (30 points at 4000 = 0.0075 %), applied to this symbol's price
  const fraction = new Prisma.Decimal(base).mul(new Prisma.Decimal(10).pow(-BASE_DIGITS)).div(ref);
  const points = fraction.mul(price).mul(new Prisma.Decimal(10).pow(symbol.digits)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return Prisma.Decimal.max(points, 1);
}

/** How many points WORSE than requested the fill is for the client (0 when equal or better). `side` is the trade being
 *  executed: BUY buys (worse = a higher price), SELL sells (worse = a lower price). A close of a BUY position sells. */
export function adverseSlippagePoints(side: "BUY" | "SELL", requested: Prisma.Decimal | string, fill: Prisma.Decimal, digits: number): Prisma.Decimal {
  const diff = side === "BUY" ? fill.sub(new Prisma.Decimal(requested)) : new Prisma.Decimal(requested).sub(fill);
  const points = diff.mul(new Prisma.Decimal(10).pow(digits));
  return points.gt(0) ? points : new Prisma.Decimal(0);
}

/** The cap in force: the smaller of the trader's own value (points; null / "unlimited" = none) and the symbol's cap. */
export function effectiveCapPoints(traderPoints: string | null | undefined, symbolCap: Prisma.Decimal | null): Prisma.Decimal | null {
  let trader: Prisma.Decimal | null = null;
  if (traderPoints != null && traderPoints !== "" && traderPoints !== "unlimited") {
    try {
      trader = new Prisma.Decimal(traderPoints);
    } catch {
      trader = null;
    }
  }
  if (trader == null) return symbolCap;
  if (symbolCap == null) return trader;
  return Prisma.Decimal.min(trader, symbolCap);
}

export type SlippageVerdict = { over: false } | { over: true; adversePoints: Prisma.Decimal; capPoints: Prisma.Decimal };

export function slippageVerdict(p: { side: "BUY" | "SELL"; requested: Prisma.Decimal | string; fill: Prisma.Decimal; digits: number; capPoints: Prisma.Decimal | null }): SlippageVerdict {
  if (p.capPoints == null) return { over: false };
  const adversePoints = adverseSlippagePoints(p.side, p.requested, p.fill, p.digits);
  return adversePoints.gt(p.capPoints) ? { over: true, adversePoints, capPoints: p.capPoints } : { over: false };
}
