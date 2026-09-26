import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { closePositionInTx, type ClosePositionOutcome } from "@/lib/position-close";
import { resolveWantsDealingQueue, deskIsOn, type RoutingGroup } from "@/lib/dealing-routing";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { orderAuditFields } from "@/lib/order-audit";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";

// Closes respect DEALER mode (docs/CLOSES-RESPECT-DEALER-MODE.md, 2026-09-18).
//
// A client's MANUAL close (single, partial, bulk, close-by) on a dealer-managed account is
// not executed on the spot: it becomes a MARKET Order with closesPositionId set -- a queued
// CLOSE -- and the position is locked (Position.closePendingOrderId) until the dealer accepts
// (closes at the dealer's price), requotes (the client answers) or rejects (position stays
// open). The one dealer queue, its accept / requote / reject handlers, the desk-off auto-flush
// and the backoffice screen all see it beside the queued opens. Automatic closes (SL / TP /
// stop-out in lib/risk-monitor.ts, the mirror) never queue; when one of them closes a locked
// position first, cancelPendingClose() retires the orphaned close order.
//
// Everything here that touches money runs inside the caller's transaction; the post-commit
// side effects (notification, events, dealer activity, mirror) are separate functions the
// caller invokes after its transaction has committed, same rule as every other trade path.

export type QueueCloseInput = {
  brokerId: string;
  accountId: string;
  position: { id: string; symbolId: string; side: "BUY" | "SELL"; volume: Prisma.Decimal; ticket?: number | null; closePendingOrderId?: string | null };
  closeVolume: Prisma.Decimal;
  requestedPrice: Prisma.Decimal | string;
  idempotencyKey: string;
  source: "WEB" | "DESKTOP_NATIVE" | "MOBILE" | "API" | "EA" | "ADMIN";
  symbolName: string;
  accountNumber: string;
  note: string;
};

export class ClosePendingError extends Error {
  constructor(public readonly orderId: string) { super("CLOSE_PENDING"); }
}

/// Does this account's routing want the dealer queue right now (the open path's exact gate, lib/dealing-routing.ts)?
/// `deskOn` is returned for the callers' dealer-activity flag.
export async function accountWantsDealingQueue(
  db: PrismaClient | Prisma.TransactionClient,
  brokerId: string,
  group: RoutingGroup | null | undefined
): Promise<{ wantsQueue: boolean; deskOn: boolean }> {
  const broker = await db.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { dealingDeskAutoFillAt: true } });
  const deskOn = deskIsOn(broker);
  return { wantsQueue: resolveWantsDealingQueue({ group, deskOn }), deskOn };
}

/// Create the queued close Order and lock the position, atomically. Throws ClosePendingError
/// when a close is already awaiting the dealer, "RACED" when the position stopped being OPEN
/// (or got locked) between the caller's read and this write.
export async function queueCloseInTx(tx: Prisma.TransactionClient, input: QueueCloseInput) {
  if (input.position.closePendingOrderId) throw new ClosePendingError(input.position.closePendingOrderId);
  const order = await tx.order.create({
    data: {
      brokerId: input.brokerId,
      accountId: input.accountId,
      symbolId: input.position.symbolId,
      side: input.position.side,
      type: "MARKET",
      volume: input.closeVolume,
      requestedPrice: new Prisma.Decimal(input.requestedPrice),
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
      source: input.source,
      closesPositionId: input.position.id,
      closeVolume: input.closeVolume,
    },
  });
  const locked = await tx.position.updateMany({
    where: { id: input.position.id, status: "OPEN", closePendingOrderId: null },
    data: { closePendingOrderId: order.id },
  });
  if (locked.count === 0) throw new Error("RACED");
  await tx.auditLog.create({
    data: {
      brokerId: input.brokerId,
      action: "DEALING_CLOSE_QUEUED",
      entityType: "Order",
      entityId: order.id,
      oldValue: {},
      newValue: {
        ...orderAuditFields(order, input.symbolName, input.accountNumber),
        closesPositionId: input.position.id,
        closesTicket: input.position.ticket ?? null,
        closeVolume: input.closeVolume.toString(),
        positionVolume: input.position.volume.toString(),
        requestedPrice: new Prisma.Decimal(input.requestedPrice).toString(),
        status: "PENDING",
        queuedForDealing: true,
        note: input.note,
      },
    },
  });
  return order;
}

/// After the queueing transaction committed: the dealer's bell, the backoffice queue row (the
/// same DealingQueued event an open sends, plus the close fields), the trader's own stream and
/// the dealer activity feed.
export async function afterCloseQueued(
  db: PrismaClient,
  p: {
    order: { id: string; createdAt: Date; requestedPrice: Prisma.Decimal | null };
    brokerId: string;
    accountId: string;
    accountNumber: string;
    accountFullName: string;
    symbolName: string;
    digits: number;
    side: "BUY" | "SELL";
    closeVolume: Prisma.Decimal;
    positionId: string;
    positionTicket?: number | null;
    positionVolume: Prisma.Decimal;
    liveBid?: Prisma.Decimal | null;
    liveAsk?: Prisma.Decimal | null;
  }
) {
  const partial = p.closeVolume.lt(p.positionVolume);
  await createNotification(db, {
    brokerId: p.brokerId,
    type: "DEALING_ORDER_PENDING",
    title: "Close awaiting dealer review",
    body: `${p.accountNumber}, close ${p.closeVolume.toString()} ${p.symbolName} ${p.side}${p.positionTicket ? ` #${p.positionTicket}` : ""}`,
    entityType: "Order",
    entityId: p.order.id,
  });
  await publishTradingEvent("OrderAccepted", { order_id: p.order.id, account_id: p.accountId, broker_id: p.brokerId });
  await publishTradingEvent("DealingQueued", {
    order_id: p.order.id,
    broker_id: p.brokerId,
    account_id: p.accountId,
    account_number: p.accountNumber,
    account_full_name: p.accountFullName,
    symbol: p.symbolName,
    digits: p.digits,
    side: p.side,
    volume: p.closeVolume.toString(),
    requested_price: p.order.requestedPrice?.toString() ?? null,
    created_at: p.order.createdAt.toISOString(),
    live_bid: p.liveBid?.toString() ?? null,
    live_ask: p.liveAsk?.toString() ?? null,
    closes_position_id: p.positionId,
    closes_ticket: p.positionTicket ?? null,
    close_volume: p.closeVolume.toString(),
    partial,
  });
  await recordDealerActivity(db, {
    brokerId: p.brokerId,
    accountId: p.accountId,
    accountNumber: p.accountNumber,
    accountFullName: p.accountFullName,
    isDealingGroup: true, // it was queued, by definition
    action: "CLOSE_REQUESTED",
    symbol: p.symbolName,
    side: p.side,
    volume: p.closeVolume.toString(),
    values: { requestedPrice: p.order.requestedPrice?.toString() ?? null, closesTicket: p.positionTicket ?? null, partial, queuedForDealing: true },
    orderId: p.order.id,
    positionId: p.positionId,
    skipNotification: true, // DEALING_ORDER_PENDING notification already fired above
  });
}

export type ExecuteQueuedCloseResult =
  | { kind: "closed"; outcome: Extract<ClosePositionOutcome, { closed: true }>; closePrice: Prisma.Decimal; closeVolume: Prisma.Decimal }
  | { kind: "position_gone" }   // the position was closed by something else first (SL / TP / stop-out / admin) -- the order is cancelled
  | { kind: "raced" };          // another dealer / tab actioned the order first

/// The dealer's ACCEPT (or the client's requote accept, or the desk-off flush) on a queued
/// close: claim the order from `fromStatus`, close the position at `closePrice`, mark the
/// order FILLED and release the lock -- all in the caller's transaction.
export async function executeQueuedCloseInTx(
  tx: Prisma.TransactionClient,
  p: {
    order: { id: string; brokerId: string; accountId: string; closesPositionId: string | null; closeVolume: Prisma.Decimal | null; volume: Prisma.Decimal };
    fromStatus: "PENDING" | "REQUOTED";
    closePrice: Prisma.Decimal;
    note: string;
  }
): Promise<ExecuteQueuedCloseResult> {
  const claimed = await tx.order.updateMany({ where: { id: p.order.id, status: p.fromStatus }, data: { status: "ACCEPTED" } });
  if (claimed.count === 0) return { kind: "raced" };
  const position = p.order.closesPositionId
    ? await tx.position.findUnique({ where: { id: p.order.closesPositionId }, include: { symbol: { select: { contractSize: true } } } })
    : null;
  if (!position || position.status !== "OPEN") {
    await tx.order.update({ where: { id: p.order.id }, data: { status: "CANCELLED", rejectionReason: "position already closed" } });
    if (position?.closePendingOrderId === p.order.id) await tx.position.update({ where: { id: position.id }, data: { closePendingOrderId: null } });
    return { kind: "position_gone" };
  }
  // a partial close asked for more than is left (the position shrank meanwhile) closes what remains
  const closeVolume = (p.order.closeVolume ?? p.order.volume).gt(position.volume) ? position.volume : (p.order.closeVolume ?? p.order.volume);
  const outcome = await closePositionInTx(tx, {
    position: {
      id: position.id,
      accountId: position.accountId,
      brokerId: position.brokerId,
      side: position.side,
      openPrice: position.openPrice,
      volume: position.volume,
      symbol: { contractSize: position.symbol.contractSize },
    },
    closePrice: p.closePrice,
    closeVolume,
    note: p.note,
  });
  if (!outcome.closed) {
    await tx.order.update({ where: { id: p.order.id }, data: { status: "CANCELLED", rejectionReason: "position already closed" } });
    await tx.position.updateMany({ where: { id: position.id, closePendingOrderId: p.order.id }, data: { closePendingOrderId: null } });
    return { kind: "position_gone" };
  }
  await tx.order.update({ where: { id: p.order.id }, data: { status: "FILLED", filledPrice: p.closePrice, filledAt: new Date() } });
  await tx.position.updateMany({ where: { id: position.id, closePendingOrderId: p.order.id }, data: { closePendingOrderId: null } });
  return { kind: "closed", outcome, closePrice: p.closePrice, closeVolume };
}

/// Post-commit side effects of an executed queued close: the mirror, the trader's stream and
/// the dealer activity feed -- what app/api/trade/positions/[id]/close does after its own close.
export async function afterQueuedCloseExecuted(
  db: PrismaClient,
  p: {
    brokerId: string;
    accountId: string;
    accountNumber: string;
    accountFullName: string;
    symbolName: string;
    side: "BUY" | "SELL";
    positionId: string;
    positionVolumeBefore: Prisma.Decimal;
    result: Extract<ExecuteQueuedCloseResult, { kind: "closed" }>;
    origin: string;
  }
) {
  await mirror
    .onClose(db, { positionId: p.positionId, brokerId: p.brokerId, closedLots: p.result.closeVolume, sourceVolumeBeforeClose: p.positionVolumeBefore, closePrice: p.result.closePrice })
    .catch((err) => console.error("mirror.onClose failed", err));
  await coverage.onClose(db, { positionId: p.positionId, brokerId: p.brokerId, closedLots: p.result.closeVolume, sourceVolumeBeforeClose: p.positionVolumeBefore, reason: "manual" }).catch((err) => console.error("coverage.onClose failed", err));
  await publishTradingEvent("PositionClosed", { position_id: p.positionId, account_id: p.accountId, broker_id: p.brokerId, reason: "manual" });
  await recordDealerActivity(db, {
    brokerId: p.brokerId,
    accountId: p.accountId,
    accountNumber: p.accountNumber,
    accountFullName: p.accountFullName,
    isDealingGroup: true,
    action: "POSITION_CLOSED",
    symbol: p.symbolName,
    side: p.side,
    volume: p.result.closeVolume.toString(),
    values: { closePrice: p.result.closePrice.toString(), partial: p.result.outcome.partial, realizedPnl: p.result.outcome.realizedPnl.toString(), closeReason: "MANUAL", origin: p.origin },
    positionId: p.positionId,
  });
}

/// Something else closed (or reduced) the position while a close was awaiting the dealer:
/// retire the orphaned order and release the lock. Used by the risk monitor (SL / TP /
/// stop-out), the admin close and the accept path's own "position gone" branch. Publishes the
/// cancel so the trader's row unlocks and the backoffice queue drops the row.
export async function cancelPendingClose(
  db: PrismaClient | Prisma.TransactionClient,
  positionId: string,
  reason: string
): Promise<string | null> {
  const position = await db.position.findUnique({ where: { id: positionId }, select: { id: true, accountId: true, brokerId: true, closePendingOrderId: true } });
  if (!position?.closePendingOrderId) return null;
  const orderId = position.closePendingOrderId;
  const cancelled = await db.order.updateMany({ where: { id: orderId, status: { in: ["PENDING", "REQUOTED"] } }, data: { status: "CANCELLED", rejectionReason: reason } });
  await db.position.updateMany({ where: { id: positionId, closePendingOrderId: orderId }, data: { closePendingOrderId: null } });
  if (cancelled.count === 0) return null;
  await db.auditLog.create({
    data: {
      brokerId: position.brokerId,
      action: "DEALING_CLOSE_SUPERSEDED",
      entityType: "Order",
      entityId: orderId,
      oldValue: { closesPositionId: positionId, status: "PENDING" },
      newValue: { status: "CANCELLED", reason },
    },
  });
  await publishTradingEvent("OrderCancelled", { order_id: orderId, account_id: position.accountId, broker_id: position.brokerId, reason });
  return orderId;
}
