import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl, closePriceFor } from "@/lib/trading";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import { checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { emitPositionClosedActivity } from "@/lib/dealer-activity";

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
  nextOpenAt?: string;
  // Closes respect DEALER mode: the position was not closed, a close Order awaiting the dealer was
  // queued instead (app/api/trade/positions/close-bulk on a dealer-managed account).
  queued?: boolean;
  orderId?: string;
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

/// Which open positions a bulk close touches, with the one fresh price per symbol every close in
/// the batch fills at and the closed-market symbols' next open -- shared by the executing path
/// below and the dealer-queue path (app/api/trade/positions/close-bulk on a dealer-managed
/// account queues one close Order per target instead of closing).
export async function selectBulkCloseTargets(
  db: Db,
  params: { accountId: string; brokerId: string; scope: BulkCloseScope; symbol?: string }
) {
  const { accountId, brokerId, scope, symbol } = params;

  const openPositions = await db.position.findMany({
    where: { accountId, status: "OPEN" },
    include: { symbol: { select: { id: true, name: true, digits: true, contractSize: true } } },
  });
  if (openPositions.length === 0) return { matching: [] as typeof openPositions, priceBySymbol: new Map<string, { bid: Prisma.Decimal; ask: Prisma.Decimal }>(), nextOpenBySymbolName: new Map<string, string>() };

  // Fix (2026-09-05 audit finding): a closed-market symbol used to fall
  // straight through to "no live price" below, identical to a genuine
  // feed outage -- same conflation close-by and the single-close/SL-TP-
  // modify routes had before those were fixed. Computed per-symbol (a
  // bulk close can span several symbols at once, each independently
  // open/closed) and treated as authoritative regardless of whatever a
  // stale LivePrice row might still say, same "closed session always
  // wins" rule lib/risk-monitor.ts's own loadOpenPositionsWithMarket
  // already applies for automatic SL/TP.
  const symbolIds = [...new Set(openPositions.map((p) => p.symbolId))];
  const brokerSymbols = await db.brokerSymbol.findMany({
    where: { brokerId, symbolId: { in: symbolIds } },
    include: { tradingSessions: true, symbol: { select: { name: true, category: true } } },
  });
  const now = new Date();
  const nextOpenBySymbolName = new Map<string, string>();
  for (const bs of brokerSymbols) {
    if (checkTradingSession(bs.tradingSessions, now, bs.symbol.category) != null) {
      nextOpenBySymbolName.set(bs.symbol.name, computeNextSessionOpen(bs.tradingSessions, now, bs.symbol.category).toISOString());
    }
  }

  // One fresh price per distinct OPEN-market symbol, fetched exactly
  // once -- this Map is reused verbatim for every position in that symbol
  // below, which is the whole point: same-symbol positions close at an
  // identical price, not whatever the feed happened to tick to between
  // sequential calls. Closed-market symbols are excluded from this fetch
  // entirely (their positions are reported via nextOpenBySymbolName
  // instead, never priced at all).
  const symbolNames = [...new Set(openPositions.map((p) => p.symbol.name))];
  const priceBySymbol = await getFreshPrices(symbolNames.filter((n) => !nextOpenBySymbolName.has(n)));

  const candidates = openPositions.filter((p) => {
    if (scope === "SYMBOL") return p.symbol.name === symbol;
    return true;
  });

  // PROFIT/LOSS classification uses the same live snapshot every close
  // below actually fills at -- never a stale/different read -- and the
  // same raw-price-diff formula the client's own positionPnl already
  // shows the trader (no commission subtracted), so "close profitable"
  // matches what was on screen when they clicked it. A closed-market
  // position can't be classified either way, but is kept in `matching`
  // (rather than silently dropped) so the loop below still reports it
  // with a real MARKET_CLOSED reason instead of it just vanishing.
  const matching = candidates.filter((p) => {
    if (scope !== "PROFIT" && scope !== "LOSS") return true;
    if (nextOpenBySymbolName.has(p.symbol.name)) return true;
    const live = priceBySymbol.get(p.symbol.name);
    if (!live) return false; // no fresh price -- can't classify, excluded (also can't close, see below)
    const cp = closePriceFor(p.side, live.bid, live.ask);
    const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: cp, volume: p.volume, contractSize: p.symbol.contractSize });
    return scope === "PROFIT" ? pnl.gte(0) : pnl.lt(0);
  });

  return { matching, priceBySymbol, nextOpenBySymbolName };
}

export async function closeBulkForAccount(
  db: Db,
  params: { accountId: string; brokerId: string; scope: BulkCloseScope; symbol?: string }
): Promise<BulkClosePositionResult[]> {
  const { brokerId, accountId, scope } = params;
  const { matching, priceBySymbol, nextOpenBySymbolName } = await selectBulkCloseTargets(db, params);
  if (matching.length === 0) return [];

  const results: BulkClosePositionResult[] = [];
  const closePriceByPositionId = new Map<string, Prisma.Decimal>();

  await withTx(db, async (tx) => {
    for (const p of matching) {
      const nextOpenAt = nextOpenBySymbolName.get(p.symbol.name);
      if (nextOpenAt) {
        results.push({ positionId: p.id, closed: false, closePrice: null, realizedPnl: null, error: "MARKET_CLOSED", nextOpenAt });
        continue;
      }
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
    await coverage.onClose(db, { positionId: source.id, brokerId, closedLots: source.volume, sourceVolumeBeforeClose: source.volume, reason: "manual" }).catch((err) => console.error("coverage.onClose failed", err));
    await emitPositionClosedActivity(db, { positionId: source.id, closePrice: closePriceByPositionId.get(source.id)!, closeVolume: source.volume, partial: false, realizedPnl: new Prisma.Decimal(r.realizedPnl!), closeReason: "MANUAL", origin: `bulk_close_${scope.toLowerCase()}` });
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
