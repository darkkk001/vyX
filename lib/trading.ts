import { Prisma } from "@prisma/client";

export type OrderSide = "BUY" | "SELL";

// Mirrors the client-side validation in vyx-webtrader.html — re-checked
// here because "authorization/validation must be enforced server-side,
// never trust a frontend check alone."
export function validateSlTp(params: {
  side: OrderSide;
  referencePrice: Prisma.Decimal | number | string;
  slPrice?: Prisma.Decimal | number | string | null;
  tpPrice?: Prisma.Decimal | number | string | null;
}): string | null {
  const ref = new Prisma.Decimal(params.referencePrice);

  if (params.slPrice != null) {
    const sl = new Prisma.Decimal(params.slPrice);
    if (params.side === "BUY" && sl.gte(ref)) return "SL must be below the reference price for a BUY";
    if (params.side === "SELL" && sl.lte(ref)) return "SL must be above the reference price for a SELL";
  }
  if (params.tpPrice != null) {
    const tp = new Prisma.Decimal(params.tpPrice);
    if (params.side === "BUY" && tp.lte(ref)) return "TP must be above the reference price for a BUY";
    if (params.side === "SELL" && tp.gte(ref)) return "TP must be below the reference price for a SELL";
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
