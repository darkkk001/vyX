// WHICH POSITIONS A BULK CLOSE TOUCHES, and in what order -- the one part of routes/positions.ts's
// close-bulk route that decides money without talking to anything.
//
// It lives in its own module, with no database import, for two reasons. The first is that it is the
// riskiest logic in that route: get the scope wrong and a trader asking to close their LOSING positions
// closes their winning ones. The second is that db.ts opens a connection pool at import time, so a test
// that reached this through the route module would need a database to assert a pure filter. Here the
// inputs are plain values and the whole thing is provable on a table (bulk-select.test.ts).
//
// The vocabulary and the semantics are the web's own (lib/bulk-close.ts selectBulkCloseTargets), because
// a client switching from that route to the Gateway's must not have to change what it sends.

import { Decimal } from "decimal.js";

export type BulkScope = "ALL" | "PROFIT" | "LOSS" | "SYMBOL";

/** Just enough of an open position to select it and classify it. Deliberately not db.ts's
 *  OpenPositionForBulk: this module must not depend on the shape of a row. */
export type BulkTarget = {
  id: string;
  side: "BUY" | "SELL";
  volume: Decimal;
  openPrice: Decimal;
  closePendingOrderId: string | null;
  symbolName: string;
  digits: number;
  contractSize: Decimal;
};

export type BulkRequest = {
  scope: BulkScope;
  symbol?: string;
  side?: "BUY" | "SELL" | null;
  positionIds?: string[];
};

export type Live = { bid: Decimal; ask: Decimal };

export type BulkSelection = {
  /** The selected positions, in the order they must settle. Everything that gets a result row is here
   *  -- the closable ones AND the refused ones -- so the answer can be assembled in one pass. */
  order: string[];
  /** Positions that are in scope but cannot be closed. They do NOT abort the basket. */
  refusals: { positionId: string; error: string }[];
  /** What goes to the engine, in settle order. */
  closable: { position: BulkTarget; live: Live }[];
};

/** The P&L sign the PROFIT / LOSS split turns on.
 *
 *  The same raw price-diff the client's own screen shows: no commission, and no FX conversion. Leaving
 *  the conversion out is not an approximation -- a conversion rate is positive, so it cannot change the
 *  SIGN, and the sign is the only thing this decides. That is what makes "close profitable" select what
 *  the trader was looking at when they pressed it. */
export function rawPnl(p: BulkTarget, closePrice: Decimal): Decimal {
  const diff = p.side === "BUY" ? closePrice.sub(p.openPrice) : p.openPrice.sub(closePrice);
  return diff.mul(p.contractSize).mul(p.volume);
}

/** `positions` must already be this account's own OPEN positions, in settle order (db.ts's
 *  getOpenPositionsForBulk returns them oldest-first). Ownership is therefore structural here, not a
 *  check: `positionIds` can only REMOVE from that set, so an id belonging to another account is never
 *  selected and this route cannot be used to probe for one.
 *
 *  ORDER IS CARRIED THROUGH, never re-sorted. A bulk close settles in the order given -- each close's
 *  balanceBefore is the previous one's balanceAfter, and the "is this the last open position" test that
 *  drives negative-balance protection is re-evaluated per position -- so re-ordering here would change
 *  the ledger, not just the listing. */
export function selectBulkBasket(
  positions: BulkTarget[],
  req: BulkRequest,
  prices: Map<string, Live>,
  markedClose: (p: BulkTarget, live: Live) => Decimal
): BulkSelection {
  const wanted = req.positionIds ? new Set(req.positionIds) : null;
  const side = req.side ?? null;

  const selection: BulkSelection = { order: [], refusals: [], closable: [] };

  for (const p of positions) {
    if (wanted && !wanted.has(p.id)) continue;
    if (side && p.side !== side) continue;
    if (req.scope === "SYMBOL" && p.symbolName !== req.symbol) continue;

    const live = prices.get(p.symbolName);
    if (!live) {
      // No fresh tick: a genuine feed outage, or a symbol whose trading session is closed. This service
      // has no port of the session calendar, so the two read the same here -- the position is reported
      // rather than priced, which is the part that matters. (The route's comment records the gap: the
      // web answers MARKET_CLOSED with a next-open time, this answers "no live price".)
      //
      // Reported even under PROFIT / LOSS, where it cannot be classified at all: a position the trader
      // asked about must come back with a reason, not vanish from the answer.
      selection.order.push(p.id);
      selection.refusals.push({ positionId: p.id, error: "no live price" });
      continue;
    }

    if (req.scope === "PROFIT" || req.scope === "LOSS") {
      const pnl = rawPnl(p, markedClose(p, live));
      // zero counts as profit, the web's own boundary (pnl.gte(0)) -- a flat position has not lost
      const keep = req.scope === "PROFIT" ? pnl.gte(0) : pnl.lt(0);
      if (!keep) continue; // out of scope entirely: no result row, exactly as the web's path does
    }

    selection.order.push(p.id);
    if (p.closePendingOrderId) {
      // a queued close already owns this position; closing it here would race the dealer
      selection.refusals.push({ positionId: p.id, error: "CLOSE_PENDING" });
      continue;
    }
    selection.closable.push({ position: p, live });
  }

  return selection;
}

/** The engine's per-position status -> the web's `error` string, so a client's existing handling of a
 *  bulk response keeps working unchanged.
 *
 *  NOT_SCOPED / NOT_DEMO cannot normally be reached (the route checks both before calling the engine)
 *  but are mapped rather than left to the default, so if the engine's scope ever changes under us the
 *  answer says so instead of claiming the position was "already closed". */
export function bulkErrorFor(status: string): string {
  switch (status) {
    case "ALREADY_CLOSED":
    case "NOT_OPEN":
      return "already closed";
    case "NOT_FOUND":
      return "position not found";
    case "NO_CONVERSION_RATE":
      return "NO_CONVERSION_RATE";
    case "NOT_SCOPED":
      return "this account is not served by the engine order path";
    case "NOT_DEMO":
      return "the engine order path serves DEMO accounts only";
    default:
      return status;
  }
}
