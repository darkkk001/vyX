import { Prisma } from "@prisma/client";

// Since the close-fields hotfix (2026-10-12) every close writes its lots, price and close-by link on the TRADE_PNL row
// (closeVolume / closePrice / closeByPositionId); those are used first. The note parsing below is only the fallback for
// rows written before that.
//
// The closes behind a History row (terminal 1.0.69, grouped History). A partial close does NOT make a second closed
// Position row: the one Position keeps its id and ticket, its volume is reduced, and every close (partial, close-by,
// the final one) writes one TRADE_PNL Transaction with referenceType "Position" and referenceId = that Position's id
// (lib/position-close.ts). That reference is the explicit link; nothing here guesses by price or time.
//
//   - partial close            note "Partial close: <lots> lots @ <price>"  (position-close.ts)
//   - close-by leg             note "Close by <other position id>"  (lib/close-by.ts) or "Close by #<ticket>" (the dealer queue path)
//   - the final close          the LAST transaction of a CLOSED position; its volume / price are the row's own
//
// A close-by leg that left the position open carries no volume or price of its own; both legs of a close-by close the SAME
// volume at the SAME price, and the smaller leg closes fully, so the figures are the counterpart's closing row. When that
// cannot be read, the position gets no `closes` at all (it stays one flat row) rather than a guess.

export type CloseLeg = {
  at: string;
  volume: string;
  price: string | null;
  pnl: string;
  /** the ticket of the position this close was made against (a close-by / hedge close), else null */
  closedByTicket: number | null;
  final: boolean;
};

export type HistoryPosition = {
  id: string;
  ticket: number;
  status: string;
  volume: Prisma.Decimal;
  closePrice: Prisma.Decimal | null;
  closedAt: Date | null;
};
export type CloseTx = {
  referenceId: string | null; amount: Prisma.Decimal; createdAt: Date; note: string | null;
  // structured close fields (null on rows written before the hotfix)
  closeVolume?: Prisma.Decimal | null; closePrice?: Prisma.Decimal | null; closeByPositionId?: string | null;
};
export type Counterpart = { id: string; ticket: number; status: string; volume: Prisma.Decimal; closePrice: Prisma.Decimal | null; closedAt: Date | null };

const PARTIAL = /^Partial close: ([0-9]+(?:\.[0-9]+)?) lots @ ([0-9]+(?:\.[0-9]+)?)$/;
const CLOSE_BY = /^Close by (#?)(\S+)$/;
/** a close-by pair closes both legs in one transaction: their rows close within this window */
const PAIR_WINDOW_MS = 5000;

/** What a close-by note names: a ticket ("#123") or a position id. */
export function closeByTarget(note: string | null): { ticket: number } | { id: string } | null {
  const m = note ? CLOSE_BY.exec(note) : null;
  if (!m) return null;
  if (m[1] === "#") { const t = Number(m[2]); return Number.isInteger(t) ? { ticket: t } : null; }
  return { id: m[2] };
}

/** The closes of one CLOSED position, oldest first; null when they cannot be stated exactly (the row stays flat). */
export function closesOf(position: HistoryPosition, txs: CloseTx[], counterparts: Counterpart[]): CloseLeg[] | null {
  if (position.status !== "CLOSED" || txs.length === 0) return null;
  const sorted = [...txs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const legs: CloseLeg[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const tx = sorted[i];
    const final = i === sorted.length - 1;
    if (tx.closeVolume != null) {
      const cp = tx.closeByPositionId ? counterparts.find((c) => c.id === tx.closeByPositionId) : undefined;
      legs.push({ at: tx.createdAt.toISOString(), volume: tx.closeVolume.toString(), price: tx.closePrice?.toString() ?? null, pnl: tx.amount.toString(), closedByTicket: cp ? cp.ticket : null, final });
      continue;
    }
    const target = closeByTarget(tx.note);
    const other = target ? counterparts.find((c) => ("ticket" in target ? c.ticket === target.ticket : c.id === target.id)) : undefined;
    const closedByTicket = other ? other.ticket : target && "ticket" in target ? target.ticket : null;
    if (final) {
      legs.push({ at: tx.createdAt.toISOString(), volume: position.volume.toString(), price: position.closePrice?.toString() ?? null, pnl: tx.amount.toString(), closedByTicket, final: true });
      continue;
    }
    const partial = tx.note ? PARTIAL.exec(tx.note) : null;
    if (partial) {
      legs.push({ at: tx.createdAt.toISOString(), volume: partial[1], price: partial[2], pnl: tx.amount.toString(), closedByTicket: null, final: false });
      continue;
    }
    // a close-by leg that left the position open: the counterpart's final row has the same volume and price
    if (other && other.status === "CLOSED" && other.closedAt && Math.abs(other.closedAt.getTime() - tx.createdAt.getTime()) <= PAIR_WINDOW_MS) {
      legs.push({ at: tx.createdAt.toISOString(), volume: other.volume.toString(), price: other.closePrice?.toString() ?? null, pnl: tx.amount.toString(), closedByTicket: other.ticket, final: false });
      continue;
    }
    return null;
  }
  const grouped = legs.length > 1 || legs.some((l) => l.closedByTicket != null) || sorted.some((t) => t.closeByPositionId);
  return grouped ? legs : null;
}
