import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";

// Replaces N sequential single-close HTTP round trips (WebTrader.tsx's
// old closeManyBy/closeManyBySymbol, and the backoffice's per-position
// close) with one request that closes every matching position in a
// single DB transaction, at one fresh price snapshot per symbol taken
// once up front -- so 30 positions in the same symbol all close at
// exactly the same price, not 30 slightly-different ticks 500ms apart.

export type BulkCloseScope = "ALL" | "PROFIT" | "LOSS" | "SYMBOL";

export type BulkClosePositionResult = {
  positionId: string;
  closed: boolean;
  closePrice: string | null;
  realizedPnl: string | null;
  error: string | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

// Same withTx shape as lib/mirror.ts's own (see that file's comment) --
// runs `fn` in a real new transaction when `db` is the top-level client
// (every real caller), or directly against `db` when it's already a
// transaction client (a test that wraps its own fixture setup + this
// call in one outer transaction it rolls back at the end).
async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

// side note for readers: BUY closes at bid, SELL closes at ask -- same
// convention as every other close site in this app (lib/risk-monitor.ts's
// closePriceFor, app/api/trade/positions/[id]/close/route.ts).
function closePriceFor(side: "BUY" | "SELL", bid: Prisma.Decimal, ask: Prisma.Decimal): Prisma.Decimal {
  return side === "BUY" ? bid : ask;
}

export async function closeBulkForAccount(
  db: Db,
  params: { accountId: string; brokerId: string; scope: BulkCloseScope; symbol?: string }
): Promise<BulkClosePositionResult[]> {
  const { accountId, brokerId, scope, symbol } = params;

  const openPositions = await db.position.findMany({
    where: { accountId, status: "OPEN" },
    include: { symbol: { select: { name: true, contractSize: true } } },
  });
  if (openPositions.length === 0) return [];

  // One fresh price per distinct symbol, fetched exactly once -- this
  // Map is reused verbatim for every position in that symbol below, which
  // is the whole point: same-symbol positions close at an identical price,
  // not whatever the feed happened to tick to between sequential calls.
  const symbolNames = [...new Set(openPositions.map((p) => p.symbol.name))];
  const priceBySymbol = await getFreshPrices(symbolNames);

  const candidates = openPositions.filter((p) => {
    if (scope === "SYMBOL") return p.symbol.name === symbol;
    return true;
  });

  // PROFIT/LOSS classification uses the same live snapshot every close
  // below actually fills at -- never a stale/different read -- and the
  // same raw-price-diff formula the client's own positionPnl already
  // shows the trader (no commission subtracted), so "close profitable"
  // matches what was on screen when they clicked it.
  const matching = candidates.filter((p) => {
    if (scope !== "PROFIT" && scope !== "LOSS") return true;
    const live = priceBySymbol.get(p.symbol.name);
    if (!live) return false; // no fresh price -- can't classify, excluded (also can't close, see below)
    const cp = closePriceFor(p.side, live.bid, live.ask);
    const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.symbol.contractSize });
    return scope === "PROFIT" ? pnl.gte(0) : pnl.lt(0);
  });

  if (matching.length === 0) return [];

  const results: BulkClosePositionResult[] = [];
  const closePriceByPositionId = new Map<string, Prisma.Decimal>();

  await withTx(db, async (tx) => {
    for (const p of matching) {
      const live = priceBySymbol.get(p.symbol.name);
      if (!live) {
        results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "no live price" });
        continue;
      }
      const closePrice = closePriceFor(p.side, live.bid, live.ask);
      closePriceByPositionId.set(p.id, closePrice);
      const outcome = await closePositionInTx(tx, {
        position: {
          id: p.id,
          accountId: p.accountId,
          brokerId: p.brokerId,
          side: p.side,
          openPrice: p.openPrice,
          volume: p.volume,
          symbol: { contractSize: p.symbol.contractSize },
        },
        closePrice,
        note: `Bulk close (${scope})`,
      });
      if (!outcome.closed) {
        // Raced with something else closing this exact position between
        // the read above and this transaction's own guarded UPDATE --
        // same benign shape as the single-close route's own handling.
        results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "already closed" });
        continue;
      }
      results.push({
        positionId: p.id,
        closed: true,
        closePrice: closePrice.toString(),
        realizedPnl: outcome.realizedPnl.toString(),
        error: null,
      });
    }
  });

  // Mirror hooks and the event publish both happen after the transaction
  // has committed, never inside it -- same rule as every other close site
  // in this app (docs/mirror.md). One mirror.onClose per position (each
  // is independently best-effort, matching the brief), but exactly one
  // PositionsClosed event for the whole batch.
  const closedResults = results.filter((r) => r.closed);
  for (const r of closedResults) {
    const source = matching.find((p) => p.id === r.positionId)!;
    await mirror
      .onClose(db, {
        positionId: source.id,
        brokerId,
        closedLots: source.volume,
        sourceVolumeBeforeClose: source.volume,
        closePrice: closePriceByPositionId.get(source.id),
      })
      .catch((err) => console.error("mirror.onClose failed", err));
  }

  if (closedResults.length > 0) {
    await publishTradingEvent("PositionsClosed", {
      broker_id: brokerId,
      account_id: accountId,
      position_ids: closedResults.map((r) => r.positionId),
      count: closedResults.length,
    });
  }

  return results;
}
