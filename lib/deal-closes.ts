import { Prisma } from "@prisma/client";
import type { CloseLeg, ClosesOptions } from "@/lib/history-closes";

// The closes behind a History row, read from the Deal table (deal model step 4) instead of being reconstructed from
// TRADE_PNL notes (lib/history-closes.ts). Same CloseLeg shape and the same grouping rules as closesOf, so the terminal
// sees no change except where the ledger could not be read: every close now has its own lots and price.
//
// One OUT / OUT_BY deal per close (partial, close-by leg, final), each linked to its TRADE_PNL row, so the P/L is the
// ledger amount exactly. A duplicate booking from before the close guard is an OUT of 0 lots: it is listed (it moved
// money) and keeps the closes' P/L equal to the ledger. A reverse in place is recorded as an OUT + IN pair with no
// ledger row (profit 0, owner decision 2026-10-19): not a close of the trade, so it is not listed here (the MT5-style
// Deals view shows it). The rule: a close is an OUT / OUT_BY deal linked to a TRADE_PNL row.

export type CloseDeal = {
  positionId: string;
  entry: "OUT" | "OUT_BY";
  ticket: bigint;
  volume: Prisma.Decimal;
  price: Prisma.Decimal;
  profit: Prisma.Decimal;
  executedAt: Date;
  byPositionId: string | null;
  transactionId: string | null;
};

/** The closes of one position from its OUT / OUT_BY deals, oldest first. `tickets` maps a close-by counterpart's id to
 *  its ticket. Without `all`: only a CLOSED position, and only when grouped (several closes or a close-by), else null. */
export function closesFromDeals(
  position: { status: string },
  deals: CloseDeal[],
  tickets: Map<string, number>,
  opts: ClosesOptions = {},
): CloseLeg[] | null {
  const all = opts.all === true;
  const closes = deals.filter((d) => d.transactionId != null);
  if ((!all && position.status !== "CLOSED") || closes.length === 0) return null;
  const sorted = [...closes].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0));
  const legs: CloseLeg[] = sorted.map((d, i) => ({
    at: d.executedAt.toISOString(),
    volume: d.volume.toString(),
    price: d.price.toString(),
    pnl: d.profit.toString(),
    closedByTicket: d.byPositionId ? tickets.get(d.byPositionId) ?? null : null,
    final: i === sorted.length - 1 && position.status === "CLOSED",
  }));
  if (all) return legs;
  const grouped = legs.length > 1 || sorted.some((d) => d.entry === "OUT_BY" || d.byPositionId != null);
  return grouped ? legs : null;
}
