import "server-only";
import { Prisma } from "@prisma/client";
import { computeRealizedPnl } from "@/lib/trading";

export type ClosePositionInput = {
  id: string;
  accountId: string;
  brokerId: string;
  side: "BUY" | "SELL";
  openPrice: Prisma.Decimal;
  volume: Prisma.Decimal;
  symbol: { contractSize: Prisma.Decimal };
};

export type ClosePositionOutcome =
  | { closed: true; position: unknown; transaction: unknown; partial: boolean; realizedPnl: Prisma.Decimal }
  | { closed: false }; // lost a race: another call already closed/reduced this position first

// The one place a trade changes the account balance. Shared by the
// trader-initiated close route (app/api/trade/positions/[id]/close) and
// the automatic risk monitor (lib/risk-monitor.ts: SL/TP triggers and
// stop-out), so both write identical Transaction/ledger records and can
// never drift into two different notions of "what closing a position
// does" -- originally duplicated inline in the close route, factored out
// here when the risk monitor needed the exact same logic.
//
// Guards against the same double-close race the Rust engine's own
// close_position_with_ledger_entry guards against (see
// engine/order-management/src/db.rs's doc comment on it): the position
// UPDATE is conditioned on status = 'OPEN' via updateMany + a rows-
// affected check, not a bare update-by-id, so two concurrent callers
// racing to close the same position (a trader clicking Close at the same
// instant the risk monitor's stop-out picks the same position) can only
// ever have one of them actually apply -- the loser gets `{closed:
// false}` back, not a silently-overwritten second close.
export async function closePositionInTx(
  tx: Prisma.TransactionClient,
  params: {
    position: ClosePositionInput;
    closePrice: Prisma.Decimal | number | string;
    closeVolume?: Prisma.Decimal; // defaults to the position's full volume
    note?: string | null;
  }
): Promise<ClosePositionOutcome> {
  const { position, closePrice, note } = params;
  const closeVolume = params.closeVolume ?? position.volume;
  const isPartial = closeVolume.lt(position.volume);

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: closeVolume,
    contractSize: position.symbol.contractSize,
  });

  const positionUpdate = isPartial
    ? await tx.position.updateMany({
        where: { id: position.id, status: "OPEN" },
        data: { volume: position.volume.sub(closeVolume) },
      })
    : await tx.position.updateMany({
        where: { id: position.id, status: "OPEN" },
        data: {
          status: "CLOSED",
          closePrice: new Prisma.Decimal(closePrice),
          realizedPnl,
          closedAt: new Date(),
        },
      });

  if (positionUpdate.count === 0) {
    // Already closed (or already reduced) by a concurrent caller between
    // this function's own caller reading the position and this UPDATE --
    // nothing to credit, nothing to write. The caller must not treat this
    // as an error; it's the expected shape of a benign race.
    return { closed: false };
  }

  const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
  const balanceBefore = account.balance;
  const balanceAfter = balanceBefore.add(realizedPnl);

  await tx.account.update({
    where: { id: position.accountId },
    data: { balance: balanceAfter },
  });

  const transaction = await tx.transaction.create({
    data: {
      brokerId: position.brokerId,
      accountId: position.accountId,
      type: "TRADE_PNL",
      status: "COMPLETED",
      amount: realizedPnl,
      balanceBefore,
      balanceAfter,
      referenceType: "Position",
      referenceId: position.id,
      note: note ?? (isPartial ? `Partial close: ${closeVolume} lots @ ${closePrice}` : null),
    },
  });

  const updatedPosition = await tx.position.findUniqueOrThrow({ where: { id: position.id } });

  return { closed: true, position: updatedPosition, transaction, partial: isPartial, realizedPnl };
}
