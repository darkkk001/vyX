import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { closePositionInTx } from "@/lib/position-close";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";

type Db = PrismaClient | Prisma.TransactionClient;

// Same withTx shape as lib/bulk-close.ts's own (see that file's
// comment) -- runs the two-leg close in a real new transaction when
// `db` is the top-level client (every real caller), or directly against
// `db` when it's already a transaction client (a test that wraps its own
// fixture setup + this call in one outer transaction it rolls back at
// the end).
async function withTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return (db as PrismaClient).$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

// "Close By" -- nets the smaller of two opposite-side positions
// on the same symbol against the larger one, without ever touching the
// open market. The whole point (over just closing both positions
// separately at the current bid/ask) is that separately closing a BUY at
// bid and a SELL at ask charges the spread on *both* legs, even though
// the two P&Ls are economically complementary and the combined total to
// the account is provably independent of which reference price is used
// (for a BUY closed at P and an opposite SELL closed at the same P, the
// two P&Ls are (P - buyOpen)*vol and (sellOpen - P)*vol -- P cancels out
// of the sum entirely). Using one identical price for both legs is what
// actually saves the spread; using bid for one and ask for the other
// would just be two ordinary closes with extra steps. The midpoint is
// the fairest single reference (favors neither side).
export type CloseByResult =
  | {
      ok: true;
      closeVolume: string;
      closePrice: string;
      positionAId: string;
      positionBId: string;
      realizedPnlA: string;
      realizedPnlB: string;
    }
  | { ok: false; error: string };

export async function closePositionsByEachOther(
  db: Db,
  params: { accountId: string; brokerId: string; positionId: string; againstPositionId: string }
): Promise<CloseByResult> {
  if (params.positionId === params.againstPositionId) {
    return { ok: false, error: "cannot close a position against itself" };
  }

  const [a, b] = await Promise.all([
    db.position.findUnique({ where: { id: params.positionId }, include: { symbol: { select: { name: true, contractSize: true } } } }),
    db.position.findUnique({ where: { id: params.againstPositionId }, include: { symbol: { select: { name: true, contractSize: true } } } }),
  ]);
  if (!a || !b || a.accountId !== params.accountId || b.accountId !== params.accountId) {
    return { ok: false, error: "position not found" };
  }
  if (a.status !== "OPEN" || b.status !== "OPEN") {
    return { ok: false, error: "both positions must be open" };
  }
  if (a.symbolId !== b.symbolId) {
    return { ok: false, error: "positions must be on the same symbol" };
  }
  if (a.side === b.side) {
    return { ok: false, error: "positions must be on opposite sides to close by each other" };
  }

  const priceMap = await getFreshPrices([a.symbol.name]);
  const live = priceMap.get(a.symbol.name);
  if (!live) {
    return { ok: false, error: "no live price for this symbol" };
  }
  const closePrice = live.bid.add(live.ask).div(2);
  const closeVolume = a.volume.lte(b.volume) ? a.volume : b.volume;

  const outcome = await withTx(db, async (tx) => {
    const outcomeA = await closePositionInTx(tx, {
      position: { id: a.id, accountId: a.accountId, brokerId: a.brokerId, side: a.side, openPrice: a.openPrice, volume: a.volume, symbol: { contractSize: a.symbol.contractSize } },
      closePrice,
      closeVolume,
      note: `Close by ${b.id}`,
    });
    if (!outcomeA.closed) return null;
    const outcomeB = await closePositionInTx(tx, {
      position: { id: b.id, accountId: b.accountId, brokerId: b.brokerId, side: b.side, openPrice: b.openPrice, volume: b.volume, symbol: { contractSize: b.symbol.contractSize } },
      closePrice,
      closeVolume,
      note: `Close by ${a.id}`,
    });
    if (!outcomeB.closed) return null;
    return { outcomeA, outcomeB };
  });

  if (!outcome) {
    // Either leg lost a race with a concurrent close (another tab, or the
    // risk monitor's own SL/TP/stop-out) between the read above and this
    // transaction's own guarded UPDATE -- same benign shape as the
    // single-close route's own handling. Partial application here would
    // leave a real position half-closed against a leg that never
    // happened, so the whole transaction is one atomic unit specifically
    // to prevent that.
    return { ok: false, error: "one of the positions was already closed or modified" };
  }

  // After the transaction has committed, never inside it -- same rule as
  // every other close site in this app.
  await mirror
    .onClose(db, { positionId: a.id, brokerId: params.brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: a.volume, closePrice })
    .catch((err) => console.error("mirror.onClose failed (close-by leg A)", err));
  await mirror
    .onClose(db, { positionId: b.id, brokerId: params.brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: b.volume, closePrice })
    .catch((err) => console.error("mirror.onClose failed (close-by leg B)", err));

  // One event for the pair, not two -- same "one event for a whole bulk
  // close" convention lib/bulk-close.ts already established.
  await publishTradingEvent("PositionsClosed", {
    broker_id: params.brokerId,
    account_id: params.accountId,
    position_ids: [a.id, b.id],
    count: 2,
  });

  return {
    ok: true,
    closeVolume: closeVolume.toString(),
    closePrice: closePrice.toString(),
    positionAId: a.id,
    positionBId: b.id,
    realizedPnlA: outcome.outcomeA.realizedPnl.toString(),
    realizedPnlB: outcome.outcomeB.realizedPnl.toString(),
  };
}
