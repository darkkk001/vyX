import { Prisma, type HedgeIntent, type HedgeResult } from "@prisma/client";

// QoreBridge M5: how the backoffice reads the hedge tables, in plain outcomes (no LP / FIX / bridge internals).

export type HedgeOutcome = "WAITING" | "HEDGED" | "PART_HEDGED" | "NOT_HEDGED" | "NEEDS_ATTENTION";

const ZERO = new Prisma.Decimal(0);

/** One intent's outcome from its legs. WAITING: claimed or not yet, a leg still on its way. NEEDS_ATTENTION: set aside
 *  (the row could not be hedged as written; an operator puts it back). Otherwise by filled lots against the intent's. */
export function hedgeOutcome(
  intent: Pick<HedgeIntent, "status" | "volume" | "side" | "clientPrice">,
  legs: Pick<HedgeResult, "status" | "filledVolume" | "avgPrice">[]
): { outcome: HedgeOutcome; filled: Prisma.Decimal; lpPrice: Prisma.Decimal | null; slippage: Prisma.Decimal | null } {
  const filled = legs.reduce((s, l) => s.add(l.filledVolume), ZERO);
  const notional = legs.reduce((s, l) => s.add(l.filledVolume.mul(l.avgPrice)), ZERO);
  const lpPrice = filled.gt(0) ? notional.div(filled).toDecimalPlaces(5) : null;
  // in the broker's favour = positive: an LP buy below / an LP sell above the client's price
  const slippage =
    lpPrice && intent.clientPrice ? (intent.side === "BUY" ? intent.clientPrice.sub(lpPrice) : lpPrice.sub(intent.clientPrice)).toDecimalPlaces(5) : null;
  let outcome: HedgeOutcome;
  if (intent.status === "ERROR") outcome = "NEEDS_ATTENTION";
  else if (intent.status !== "DONE" || legs.length === 0 || legs.some((l) => l.status === "ROUTED")) outcome = "WAITING";
  else if (filled.gte(intent.volume)) outcome = "HEDGED";
  else if (filled.gt(0)) outcome = "PART_HEDGED";
  else outcome = "NOT_HEDGED";
  return { outcome, filled, lpPrice, slippage };
}

/** Per symbol: the clients' net A-book lots against the lots the LPs filled (BUY positive); unhedged = clients - LPs.
 *  Lots as plain decimal strings ("0" when hedged exactly), symbols sorted. */
export function hedgeExposure(
  client: { symbol: string; net: Prisma.Decimal | null }[],
  lp: { symbol: string; net: Prisma.Decimal | null }[]
): { symbol: string; clientNetLots: string; hedgedNetLots: string; unhedgedLots: string }[] {
  const symbols = new Set([...client.map((c) => c.symbol), ...lp.map((l) => l.symbol)]);
  const get = (rows: { symbol: string; net: Prisma.Decimal | null }[], s: string) => new Prisma.Decimal(rows.find((r) => r.symbol === s)?.net ?? 0);
  const fmt = (d: Prisma.Decimal) => (d.isZero() ? "0" : d.toDecimalPlaces(2).toString());
  return [...symbols]
    .sort()
    .map((symbol) => {
      const c = get(client, symbol);
      const h = get(lp, symbol);
      return { symbol, clientNetLots: fmt(c), hedgedNetLots: fmt(h), unhedgedLots: fmt(c.sub(h)) };
    })
    .filter((e) => e.clientNetLots !== "0" || e.hedgedNetLots !== "0" || e.unhedgedLots !== "0");
}
