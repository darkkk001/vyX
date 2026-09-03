import "server-only";
import { Prisma, PositionActionType, type Position, type OrderSide } from "@prisma/client";
import { getFreshPrice } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { randomUUID } from "node:crypto";

type Tx = Prisma.TransactionClient;

// Backoffice manual position tools (VYX-POSITION-TOOLS-V0) -- shared by
// every route under app/api/manage/positions/[id]/{reverse,void,delete}
// and app/api/manage/position-action-requests/*. BROKER_ADMIN executes
// every action here directly; MANAGER's request needs a *different*
// admin's approval first (see PositionActionRequest's own schema
// comment) -- generalizes lib/funds-approval.ts's mark/approve shape
// from "a different admin" (funds, unconditionally) to "gated by which
// role is acting" here, since unlike a funds request a position action
// has a role (BROKER_ADMIN) that's trusted to execute solo.
export function positionActionNeedsApproval(role: "MANAGER" | "BROKER_ADMIN"): boolean {
  return role === "MANAGER";
}

// A position is "mirror-relevant" if its account, or its account's
// group, is the SOURCE side of any enabled MirrorRule -- i.e. some other
// account's positions are being driven off this one. Reverse-in-place
// doesn't touch the mirror hook at all (see executeReverseInPlace's own
// comment), so this is surfaced as a warning for the acting admin to
// judge, not enforced -- the mirrored target's own position now silently
// disagrees with its source's new side until someone manually corrects
// it too.
export async function isAccountMirrored(tx: Tx, accountId: string, groupId: string | null): Promise<boolean> {
  const rule = await tx.mirrorRule.findFirst({
    where: {
      enabled: true,
      OR: [{ sourceType: "ACCOUNT", sourceId: accountId }, ...(groupId ? [{ sourceType: "GROUP" as const, sourceId: groupId }] : [])],
    },
    select: { id: true },
  });
  return rule !== null;
}

export class PositionActionError extends Error {}

async function loadOpenPosition(tx: Tx, brokerId: string, positionId: string) {
  const position = await tx.position.findUnique({
    where: { id: positionId },
    include: {
      symbol: { select: { name: true, contractSize: true } },
      account: { select: { accountNumber: true, groupId: true } },
    },
  });
  if (!position || position.brokerId !== brokerId) throw new PositionActionError("position not found");
  if (position.status !== "OPEN") throw new PositionActionError("position is not open");
  return position;
}

// ---------- Reverse: in-place flip (new default) ----------
// Same position, same entry price, side inverted -- no close event, no
// new position row, no realized P/L, no Transaction at all (this is a
// correction, not a trade). Margin is intentionally left untouched: this
// app's own margin formula (lib/margin.ts's requiredMarginFor) is
// side-independent (volume * contractSize * CURRENT price / leverage),
// so there is nothing stored on Position for a side flip to update --
// every margin snapshot already recomputes live from whichever side is
// current the moment it's read.
export type ReverseInPlaceResult = {
  kind: "REVERSE_IN_PLACE";
  position: Position;
  accountId: string;
  oldSide: OrderSide;
  newSide: OrderSide;
  floatingPnlAtFlip: Prisma.Decimal | null;
  mirrorWarning: boolean;
};

export async function executeReverseInPlace(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string }
): Promise<ReverseInPlaceResult> {
  const position = await loadOpenPosition(tx, params.brokerId, params.positionId);
  const oldSide = position.side;
  const newSide: OrderSide = oldSide === "BUY" ? "SELL" : "BUY";

  const price = await getFreshPrice(position.symbol.name);
  const floatingPnlAtFlip = price
    ? computeRealizedPnl({
        side: newSide,
        openPrice: position.openPrice,
        closePrice: newSide === "BUY" ? price.ask : price.bid,
        volume: position.volume,
        contractSize: position.symbol.contractSize,
      })
    : null;
  const floatingPnlBefore = price
    ? computeRealizedPnl({
        side: oldSide,
        openPrice: position.openPrice,
        closePrice: oldSide === "BUY" ? price.ask : price.bid,
        volume: position.volume,
        contractSize: position.symbol.contractSize,
      })
    : null;

  const updated = await tx.position.update({ where: { id: position.id }, data: { side: newSide } });
  const mirrorWarning = await isAccountMirrored(tx, position.accountId, position.account.groupId);

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "POSITION_REVERSED_IN_PLACE",
      entityType: "Position",
      entityId: position.id,
      oldValue: { side: oldSide, floatingPnl: floatingPnlBefore?.toString() ?? null },
      newValue: {
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        side: newSide,
        floatingPnl: floatingPnlAtFlip?.toString() ?? null,
        openPrice: position.openPrice.toString(),
        mirrorRelevant: mirrorWarning,
      },
    },
  });

  return { kind: "REVERSE_IN_PLACE", position: updated, accountId: position.accountId, oldSide, newSide, floatingPnlAtFlip, mirrorWarning };
}

// ---------- Reverse: close & reopen opposite @ market (old behavior, kept) ----------
export type ReverseCloseReopenResult = {
  kind: "REVERSE_CLOSE_REOPEN";
  accountId: string;
  closedPositionId: string;
  realizedPnl: Prisma.Decimal;
  newPosition: Position;
  newSide: OrderSide;
  openPrice: Prisma.Decimal;
  closePrice: Prisma.Decimal;
  symbolName: string;
  volume: Prisma.Decimal;
};

export async function executeReverseCloseReopen(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string }
): Promise<ReverseCloseReopenResult> {
  const position = await loadOpenPosition(tx, params.brokerId, params.positionId);
  const price = await getFreshPrice(position.symbol.name);
  if (!price) throw new PositionActionError(`no live price for ${position.symbol.name}`);

  const brokerSymbol = await tx.brokerSymbol.findFirst({ where: { brokerId: params.brokerId, symbolId: position.symbolId } });
  const closePrice = position.side === "BUY" ? price.bid : price.ask;
  const newSide: OrderSide = position.side === "BUY" ? "SELL" : "BUY";
  const openPrice = newSide === "BUY" ? price.ask : price.bid;

  const realizedPnl = computeRealizedPnl({
    side: position.side,
    openPrice: position.openPrice,
    closePrice,
    volume: position.volume,
    contractSize: position.symbol.contractSize,
  });

  const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
  const balanceBefore = account.balance;
  const balanceAfter = balanceBefore.add(realizedPnl);

  await tx.position.update({
    where: { id: position.id },
    data: { status: "CLOSED", closePrice, realizedPnl, closedAt: new Date(), closedByAdminId: params.adminId },
  });
  await tx.account.update({ where: { id: position.accountId }, data: { balance: balanceAfter } });
  await tx.transaction.create({
    data: {
      brokerId: params.brokerId,
      accountId: position.accountId,
      type: "TRADE_PNL",
      status: "COMPLETED",
      amount: realizedPnl,
      balanceBefore,
      balanceAfter,
      referenceType: "Position",
      referenceId: position.id,
      note: `Reversed (close & reopen) by admin @ ${closePrice}`,
    },
  });

  const newOrder = await tx.order.create({
    data: {
      brokerId: params.brokerId,
      accountId: position.accountId,
      symbolId: position.symbolId,
      side: newSide,
      type: "MARKET",
      volume: position.volume,
      requestedPrice: openPrice,
      idempotencyKey: `manual_${randomUUID()}`,
      status: "FILLED",
      filledPrice: openPrice,
      filledAt: new Date(),
    },
  });
  const newPosition = await tx.position.create({
    data: {
      brokerId: params.brokerId,
      accountId: position.accountId,
      symbolId: position.symbolId,
      originOrderId: newOrder.id,
      side: newSide,
      volume: position.volume,
      openPrice,
      bookType: brokerSymbol?.defaultBookType ?? "B_BOOK",
    },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "MANUAL_POSITION_REVERSE",
      entityType: "Position",
      entityId: position.id,
      oldValue: { side: position.side, status: "OPEN" },
      newValue: {
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        closedSide: position.side,
        closePrice: closePrice.toString(),
        realizedPnl: realizedPnl.toString(),
        newPositionId: newPosition.id,
        newSide,
        openPrice: openPrice.toString(),
      },
    },
  });

  return {
    kind: "REVERSE_CLOSE_REOPEN",
    accountId: position.accountId,
    closedPositionId: position.id,
    realizedPnl,
    newPosition,
    newSide,
    openPrice,
    closePrice,
    symbolName: position.symbol.name,
    volume: position.volume,
  };
}

// ---------- Void ----------
// Redefined (was "manual-origin only, always zero balance impact" --
// see this route's prior comment): now cancels ANY open position as if
// it never produced a P/L, reversing every real balance effect it's had
// so far -- its own commission (COMMISSION Transactions carry
// referenceType/referenceId: "Position"/this id, see
// lib/group-pricing.ts's chargeCommission) plus its own accrued swap
// (Position.swap -- the daily rollover batches one Transaction per
// ACCOUNT per day with no per-position referenceId, so this running
// total is the only place "this position's share" survives to reverse).
// No realized P&L exists to reverse -- this app has no partial-close, so
// an OPEN position by definition has never booked one.
export type VoidResult = {
  kind: "VOID";
  accountId: string;
  position: Position;
  reversalAmount: Prisma.Decimal;
  balanceBefore: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
};

export async function executeVoid(tx: Tx, params: { brokerId: string; positionId: string; adminId: string }): Promise<VoidResult> {
  const position = await loadOpenPosition(tx, params.brokerId, params.positionId);

  const positionTxns = await tx.transaction.aggregate({
    where: { accountId: position.accountId, referenceType: "Position", referenceId: position.id, status: "COMPLETED" },
    _sum: { amount: true },
  });
  const bookedAgainstPosition = positionTxns._sum.amount ?? new Prisma.Decimal(0);
  // bookedAgainstPosition (e.g. commission) is stored signed as it hit
  // balance already (negative for a debit) -- negating gives back the
  // credit. position.swap is the raw amount already added to balance by
  // the rollover job -- subtracting undoes it the same way regardless of
  // its own sign.
  const reversalAmount = bookedAgainstPosition.neg().sub(position.swap);

  const account = await tx.account.findUniqueOrThrow({ where: { id: position.accountId } });
  const balanceBefore = account.balance;
  const balanceAfter = balanceBefore.add(reversalAmount);

  if (!reversalAmount.isZero()) {
    await tx.account.update({ where: { id: position.accountId }, data: { balance: balanceAfter } });
    await tx.transaction.create({
      data: {
        brokerId: params.brokerId,
        accountId: position.accountId,
        type: "ADJUSTMENT",
        status: "COMPLETED",
        amount: reversalAmount,
        balanceBefore,
        balanceAfter,
        referenceType: "Position",
        referenceId: position.id,
        note: "Void reversal -- undoes commission/swap booked against this position",
      },
    });
  }

  const updated = await tx.position.update({
    where: { id: position.id },
    data: { status: "VOIDED", closedAt: new Date(), closedByAdminId: params.adminId },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "MANUAL_POSITION_VOID",
      entityType: "Position",
      entityId: position.id,
      oldValue: { status: "OPEN", balance: balanceBefore.toString() },
      newValue: {
        status: "VOIDED",
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        side: position.side,
        volume: position.volume.toString(),
        reversalAmount: reversalAmount.toString(),
        balanceAfter: balanceAfter.toString(),
      },
    },
  });

  return { kind: "VOID", accountId: position.accountId, position: updated, reversalAmount, balanceBefore, balanceAfter };
}

// ---------- Delete ----------
// Soft-delete only -- the row (and every FK/report referencing it) never
// physically disappears, it just stops showing up in the trader-visible
// statement/history (see Position.deletedAt's own schema comment) and
// stays fully recoverable from the audit view. Distinct from VOID: VOID
// undoes an OPEN position's balance impact; DELETE just hides a row
// (closed or voided) from the trader, e.g. for a genuinely duplicate or
// test entry that shouldn't have existed at all. OPEN positions are
// deliberately not eligible: hiding a still-live position from the
// trader (app/api/trade/positions's own deletedAt filter) while it keeps
// floating and counting in backoffice margin/exposure would strand it --
// invisible to the trader, unmanageable (no SL/TP, no close), un-closed
// forever. Void or close it first.
export type DeleteResult = { kind: "DELETE"; accountId: string; position: Position };

export async function executeDelete(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string; reason: string }
): Promise<DeleteResult> {
  const position = await tx.position.findUnique({
    where: { id: params.positionId },
    include: { account: { select: { accountNumber: true } }, symbol: { select: { name: true } } },
  });
  if (!position || position.brokerId !== params.brokerId) throw new PositionActionError("position not found");
  if (position.status === "OPEN") throw new PositionActionError("cannot delete an open position -- void or close it first");
  if (position.deletedAt) throw new PositionActionError("position already deleted");

  const updated = await tx.position.update({
    where: { id: position.id },
    data: { deletedAt: new Date(), deletedByAdminId: params.adminId, deleteReason: params.reason },
  });

  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "POSITION_DELETED",
      entityType: "Position",
      entityId: position.id,
      oldValue: { deletedAt: null },
      newValue: {
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        status: position.status,
        reason: params.reason,
      },
    },
  });

  return { kind: "DELETE", accountId: position.accountId, position: updated };
}

export type PositionActionExecResult = ReverseInPlaceResult | ReverseCloseReopenResult | VoidResult | DeleteResult;

async function dispatchExecute(
  tx: Tx,
  actionType: PositionActionType,
  params: { brokerId: string; positionId: string; adminId: string; reason: string | null }
): Promise<PositionActionExecResult> {
  switch (actionType) {
    case "REVERSE_IN_PLACE":
      return executeReverseInPlace(tx, params);
    case "REVERSE_CLOSE_REOPEN":
      return executeReverseCloseReopen(tx, params);
    case "VOID":
      return executeVoid(tx, params);
    case "DELETE":
      return executeDelete(tx, { ...params, reason: params.reason ?? "" });
  }
}

// ---------- MANAGER maker-checker: request / approve / reject ----------
export async function requestPositionAction(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string; actionType: PositionActionType; reason: string | null }
) {
  // Same-shape existence/status guard as the direct-execute path, so a
  // MANAGER gets the same "not found"/"not open" error at request time
  // instead of only discovering it once a checker tries to approve.
  if (params.actionType === "DELETE") {
    const position = await tx.position.findUnique({ where: { id: params.positionId } });
    if (!position || position.brokerId !== params.brokerId) throw new PositionActionError("position not found");
    if (position.status === "OPEN") throw new PositionActionError("cannot delete an open position -- void or close it first");
    if (position.deletedAt) throw new PositionActionError("position already deleted");
  } else {
    await loadOpenPosition(tx, params.brokerId, params.positionId);
  }

  const request = await tx.positionActionRequest.create({
    data: {
      brokerId: params.brokerId,
      positionId: params.positionId,
      actionType: params.actionType,
      requestedByAdminId: params.adminId,
      reason: params.reason,
    },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "POSITION_ACTION_REQUESTED",
      entityType: "Position",
      entityId: params.positionId,
      newValue: { requestId: request.id, actionType: params.actionType, reason: params.reason },
    },
  });
  return request;
}

export type ApprovePositionActionResult =
  | { ok: true; requestId: string; execResult: PositionActionExecResult }
  | { ok: false; error: string };

export async function approvePositionActionRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<ApprovePositionActionResult> {
  const request = await tx.positionActionRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };
  if (request.requestedByAdminId === params.adminId) return { ok: false, error: "a different staff member must approve this request" };

  let execResult: PositionActionExecResult;
  try {
    execResult = await dispatchExecute(tx, request.actionType, {
      brokerId: params.brokerId,
      positionId: request.positionId,
      adminId: params.adminId,
      reason: request.reason,
    });
  } catch (err) {
    return { ok: false, error: err instanceof PositionActionError ? err.message : "action failed" };
  }

  await tx.positionActionRequest.update({
    where: { id: request.id },
    data: { status: "APPROVED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "POSITION_ACTION_APPROVED",
      entityType: "Position",
      entityId: request.positionId,
      newValue: { requestId: request.id, actionType: request.actionType },
    },
  });

  return { ok: true, requestId: request.id, execResult };
}

export async function rejectPositionActionRequest(
  tx: Tx,
  params: { requestId: string; brokerId: string; adminId: string; reviewNote: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await tx.positionActionRequest.findUnique({ where: { id: params.requestId } });
  if (!request || request.brokerId !== params.brokerId) return { ok: false, error: "request not found" };
  if (request.status !== "PENDING") return { ok: false, error: "request already reviewed" };

  await tx.positionActionRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED", reviewedByAdminId: params.adminId, reviewedAt: new Date(), reviewNote: params.reviewNote },
  });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "POSITION_ACTION_REJECTED",
      entityType: "Position",
      entityId: request.positionId,
      newValue: { requestId: request.id, actionType: request.actionType, reviewNote: params.reviewNote },
    },
  });
  return { ok: true };
}
