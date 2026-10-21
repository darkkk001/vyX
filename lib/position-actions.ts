import "server-only";
import { Prisma, PositionActionType, type Position, type OrderSide } from "@prisma/client";
import { getFreshPrice } from "@/lib/live-price";
import { hasEligibleApprover, NEEDS_BROKER_ADMIN } from "@/lib/approvers";
import { checkAccountTradingRights, checkTradingSession, computeNextSessionOpen } from "@/lib/risk";
import { loadRateResolver } from "@/lib/fx";
import { computeRealizedPnl } from "@/lib/trading";
import { resolveBookType } from "@/lib/group-pricing";
import { closePositionInTx } from "@/lib/position-close";
import { randomUUID } from "node:crypto";
import { lockAccountBalance, lockAccountFunds } from "@/lib/account-lock";
import { accountClosePrice, loadAccountAskRules } from "@/lib/ask-markup";
import { markDealsVoidedInTx, writeFlipDealsInTx, writeOpenDealInTx } from "@/lib/deals";

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
      symbol: { select: { name: true, category: true, contractSize: true, quoteCurrency: true } },
      account: { select: { accountNumber: true, groupId: true, currency: true, status: true, tradingRights: true } },
    },
  });
  if (!position || position.brokerId !== brokerId) throw new PositionActionError("position not found");
  if (position.status !== "OPEN") throw new PositionActionError("position is not open");
  return position;
}

// Void accepts an OPEN position (cancel it as if it never produced a P/L) or a CLOSED one (reverse its booked result,
// owner decision 2026-10-07). Nothing else: a VOIDED position is already void.
async function loadVoidablePosition(tx: Tx, brokerId: string, positionId: string) {
  const position = await tx.position.findUnique({
    where: { id: positionId },
    include: {
      symbol: { select: { name: true, category: true, contractSize: true, quoteCurrency: true } },
      account: { select: { accountNumber: true, groupId: true, currency: true, status: true, tradingRights: true } },
    },
  });
  if (!position || position.brokerId !== brokerId) throw new PositionActionError("position not found");
  if (position.status === "VOIDED") throw new PositionActionError("trade is already voided");
  if (position.status === "CLOSED" && position.account.status === "CLOSED") throw new PositionActionError("account is closed");
  return position;
}

// Per-account trading rights (2026-09-28): a reverse opens the opposite side, so it is an OPEN for the gate -- a
// close-only / read-only / suspended account cannot be reversed (both modes). Closing it stays possible.
function assertMayOpen(position: { account: { status: "ACTIVE" | "SUSPENDED" | "CLOSED"; tradingRights: "FULL" | "CLOSE_ONLY" | "READ_ONLY" } }) {
  const refused = checkAccountTradingRights(position.account, "open");
  if (refused) throw new PositionActionError(`reverse refused: ${refused}`);
}

// ---------- Admin close (app/api/manage/positions/[id]/close) ----------
// The dealer's manual close, full or partial. Until 2026-09-23 the route wrote this with a bare
// update-by-id: no status guard (a double click, or the risk monitor closing the same position a moment
// earlier, credited the account twice) and no negative-balance protection (a deep loss closed by a dealer
// drove the balance below zero). It now goes through closePositionInTx like every other close; this adds
// only what is specific to an admin close. `position` is the route's own pre-transaction read: if the row
// changed since (closed, or reduced by another close), the guard refuses and nothing is written.
export type AdminCloseResult =
  | { closed: true; partial: boolean; realizedPnl: Prisma.Decimal; position: unknown }
  | { closed: false };

export async function executeAdminCloseInTx(
  tx: Tx,
  params: {
    brokerId: string;
    adminId: string;
    position: {
      id: string;
      accountId: string;
      side: OrderSide;
      openPrice: Prisma.Decimal;
      volume: Prisma.Decimal;
      symbol: { name: string; contractSize: Prisma.Decimal };
      account: { accountNumber: string };
    };
    closePrice: Prisma.Decimal;
    closeVolume: Prisma.Decimal;
    closeByPositionId?: string | null; // staff close-by: the opposite leg
  }
): Promise<AdminCloseResult> {
  const { brokerId, adminId, position, closePrice, closeVolume } = params;
  const isPartial = closeVolume.lt(position.volume);
  const outcome = await closePositionInTx(tx, {
    position: { id: position.id, accountId: position.accountId, brokerId, side: position.side, openPrice: position.openPrice, volume: position.volume, symbol: { contractSize: position.symbol.contractSize } },
    closePrice,
    closeVolume,
    note: isPartial ? `Manual partial close by admin: ${closeVolume} lots @ ${closePrice}` : `Manual close by admin @ ${closePrice}`,
    closeByPositionId: params.closeByPositionId ?? null,
    deal: { reason: "ADMIN", source: "ADMIN", adminId, capture: { requestedAt: new Date(), platform: "Backoffice", executionMode: "DEALER" } },
  });
  if (!outcome.closed) return { closed: false };

  const updated = isPartial
    ? outcome.position
    : await tx.position.update({ where: { id: position.id }, data: { closedByAdminId: adminId } });
  await tx.auditLog.create({
    data: {
      brokerId,
      actorAdminId: adminId,
      action: "MANUAL_POSITION_CLOSE",
      entityType: "Position",
      entityId: position.id,
      oldValue: { status: "OPEN", volume: position.volume.toString() },
      newValue: {
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        closeVolume: closeVolume.toString(),
        closePrice: closePrice.toString(),
        realizedPnl: outcome.realizedPnl.toString(),
        partial: isPartial,
      },
    },
  });
  return { closed: true, partial: isPartial, realizedPnl: outcome.realizedPnl, position: updated };
}

// ---------- Reverse: in-place flip (new default) ----------
// Same position, same entry price, side inverted -- no close event, no
// new position row, no realized P/L, no Transaction at all (this is a
// correction, not a trade); its deal history gets an OUT + IN pair at the
// entry price (writeFlipDealsInTx), for it and for every follower it flips.
// Margin is intentionally left untouched: this
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
  /** positions flipped with it (the broker's hedge leg, a mirrored copy), for the caller's PositionModified events */
  followers: { positionId: string; accountId: string }[];
};

export async function executeReverseInPlace(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string }
): Promise<ReverseInPlaceResult> {
  const position = await loadOpenPosition(tx, params.brokerId, params.positionId);
  assertMayOpen(position);
  const oldSide = position.side;
  const newSide: OrderSide = oldSide === "BUY" ? "SELL" : "BUY";

  const price = await getFreshPrice(position.symbol.name);
  // FX (Phase 2 batch 1): the audited floating P/L is in the account's currency; no rate = unpriced (null)
  const fxRate = price ? (await loadRateResolver(tx, [[position.symbol.quoteCurrency, position.account.currency]])).rate(position.symbol.quoteCurrency, position.account.currency) : null;
  const floatingPnlAtFlip = price && fxRate
    ? computeRealizedPnl({
        side: newSide,
        openPrice: position.openPrice,
        closePrice: newSide === "BUY" ? price.ask : price.bid,
        volume: position.volume,
        contractSize: position.symbol.contractSize,
      }).mul(fxRate)
    : null;
  const floatingPnlBefore = price && fxRate
    ? computeRealizedPnl({
        side: oldSide,
        openPrice: position.openPrice,
        closePrice: oldSide === "BUY" ? price.ask : price.bid,
        volume: position.volume,
        contractSize: position.symbol.contractSize,
      }).mul(fxRate)
    : null;

  const updated = await tx.position.update({ where: { id: position.id }, data: { side: newSide } });
  await writeFlipDealsInTx(tx, { positionId: position.id, adminId: params.adminId });
  const mirrorWarning = await isAccountMirrored(tx, position.accountId, position.account.groupId);

  // Audit 2026-09-24 (money): the positions that follow this one flip with it, in the same transaction -- an in-place
  // reverse is a correction, not a trade, so their counterparts are corrected the same way (same entry, side
  // inverted, nothing realized). Before, a covered position's hedge leg stayed on the old side (the broker hedged
  // the wrong way) and a mirrored copy kept the old direction.
  const followers: { positionId: string; accountId: string }[] = [];
  if (position.coveragePositionId) {
    const leg = await tx.position.findUnique({ where: { id: position.coveragePositionId }, select: { id: true, accountId: true, side: true, status: true, ticket: true } });
    if (leg && leg.status === "OPEN") {
      const legSide: OrderSide = leg.side === "BUY" ? "SELL" : "BUY";
      await tx.position.update({ where: { id: leg.id }, data: { side: legSide } });
      await writeFlipDealsInTx(tx, { positionId: leg.id, adminId: params.adminId });
      followers.push({ positionId: leg.id, accountId: leg.accountId });
      await tx.auditLog.create({
        data: {
          brokerId: params.brokerId,
          actorAdminId: params.adminId,
          action: "POSITION_COVERAGE_REVERSED_IN_PLACE",
          entityType: "Position",
          entityId: leg.id,
          oldValue: { side: leg.side },
          newValue: { side: legSide, clientPositionId: position.id, legTicket: leg.ticket },
        },
      });
    }
  }
  const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: position.id } });
  if (link) {
    const copy = await tx.position.findUnique({ where: { id: link.targetPositionId }, select: { id: true, accountId: true, side: true, status: true } });
    if (copy && copy.status === "OPEN") {
      const copySide: OrderSide = copy.side === "BUY" ? "SELL" : "BUY";
      await tx.position.update({ where: { id: copy.id }, data: { side: copySide } });
      await writeFlipDealsInTx(tx, { positionId: copy.id, adminId: params.adminId });
      followers.push({ positionId: copy.id, accountId: copy.accountId });
      await tx.auditLog.create({
        data: {
          brokerId: params.brokerId,
          actorAdminId: params.adminId,
          action: "MIRROR_REVERSED_IN_PLACE",
          entityType: "Position",
          entityId: copy.id,
          oldValue: { side: copy.side },
          newValue: { side: copySide, sourcePositionId: position.id, ruleId: link.ruleId },
        },
      });
    }
  }

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

  return { kind: "REVERSE_IN_PLACE", position: updated, accountId: position.accountId, oldSide, newSide, floatingPnlAtFlip, mirrorWarning, followers };
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
  assertMayOpen(position);

  // 2026-09-06 Section E audit fix -- this mode actually fills a close
  // and a new open at live market prices (unlike REVERSE_IN_PLACE, which
  // never touches price at all), so it needs the same explicit session
  // check every trader-facing close/fill path already has, not just
  // getFreshPrice's staleness proxy. See the identical fix in
  // app/api/manage/positions/[id]/close/route.ts for the full reasoning.
  const brokerSymbol = await tx.brokerSymbol.findFirst({
    where: { brokerId: params.brokerId, symbolId: position.symbolId },
    include: { tradingSessions: true },
  });
  const sessionError = checkTradingSession(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
  if (sessionError) {
    const nextOpenAt = computeNextSessionOpen(brokerSymbol?.tradingSessions ?? [], new Date(), position.symbol.category);
    throw new PositionActionError(`Market closed for ${position.symbol.name}, opens ${nextOpenAt.toISOString()}`);
  }

  const price = await getFreshPrice(position.symbol.name);
  if (!price) throw new PositionActionError(`no live price for ${position.symbol.name}`);

  // every ask-side execution at the ACCOUNT's ask (lib/ask-markup.ts, owner decision 2026-09-26): a SELL closes at it
  // and the reversed BUY opens at it (it used to open at the raw ask, below what a trader's own BUY pays)
  const askRuleFor = await loadAccountAskRules(tx, position.accountId, [position.symbolId]);
  const accountAsk = accountClosePrice("SELL", price.bid, price.ask, askRuleFor(position.symbolId));
  const closePrice = position.side === "BUY" ? price.bid : accountAsk;
  const newSide: OrderSide = position.side === "BUY" ? "SELL" : "BUY";
  const openPrice = newSide === "BUY" ? accountAsk : price.bid;

  const account = await tx.account.findUniqueOrThrow({
    where: { id: position.accountId },
    include: { group: { select: { category: true } } },
  });

  // The close leg goes through closePositionInTx (2026-09-23): it used to be a bare update-by-id plus its
  // own balance write, so it had no status guard (a concurrent close could be paid twice) and no
  // negative-balance protection (a deep loss left the balance below zero).
  const closed = await closePositionInTx(tx, {
    position: { id: position.id, accountId: position.accountId, brokerId: params.brokerId, side: position.side, openPrice: position.openPrice, volume: position.volume, symbol: { contractSize: position.symbol.contractSize } },
    closePrice,
    note: `Reversed (close & reopen) by admin @ ${closePrice}`,
    deal: { reason: "REVERSE", source: "ADMIN", adminId: params.adminId },
  });
  if (!closed.closed) throw new PositionActionError("position was closed or changed by another action, refresh and try again");
  const realizedPnl = closed.realizedPnl;
  await tx.position.update({ where: { id: position.id }, data: { closedByAdminId: params.adminId } });

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
      // Order-origin tracking -- an admin/dealer action on the client's
      // behalf, not the client's own order; mislabeling this WEB would
      // be actively wrong for an audit trail, not just imprecise.
      source: "ADMIN",
      filledPrice: openPrice,
      filledAt: new Date(),
      executedAt: new Date(), executionMode: "DEALER", platform: "Backoffice", routing: resolveBookType(account.group.category), // execution capture
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
      // Stage 3b: the reversed leg books where the ACCOUNT's group routes, not
      // where the symbol's (now unused) default said. This previously stamped
      // B_BOOK onto a reversal opened on an A_BOOK or COVERAGE account.
      bookType: resolveBookType(account.group.category),
      reversedFromPositionId: position.id,
    },
  });
  await writeOpenDealInTx(tx, { positionId: newPosition.id, reason: "REVERSE", adminId: params.adminId });

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
  const position = await loadVoidablePosition(tx, params.brokerId, params.positionId);
  if (position.status === "CLOSED") return executeVoidClosed(tx, params, position);

  // Claim the position BEFORE any money moves (2026-09-23): the status flip is conditioned on the row
  // still being exactly what was read (OPEN, same volume), so a concurrent void or close makes this one
  // stop here instead of reversing the commission/swap a second time.
  const claim = await tx.position.updateMany({
    where: { id: position.id, status: "OPEN", volume: position.volume },
    data: { status: "VOIDED", closedAt: new Date(), closedByAdminId: params.adminId },
  });
  if (claim.count === 0) throw new PositionActionError("position was closed or changed by another action, refresh and try again");
  await markDealsVoidedInTx(tx, position.id);

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

  const balanceBefore = await lockAccountBalance(tx, position.accountId); // row lock: lib/account-lock.ts
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
        note: `Void of #${position.ticket}: undoes the commission and swap booked against it`,
      },
    });
  }

  const updated = await tx.position.findUniqueOrThrow({
    where: { id: position.id }, // claimed (VOIDED) above
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

// ---------- Void a CLOSED trade (owner decision 2026-10-07) ----------
// Reverses every balance effect the trade booked: its commission and realized P/L (TRADE_PNL rows, partial closes
// included), the credit a loss used (the balance part reversed, the credit pool restored) and the negative-balance
// write-off, plus its accrued swap. One ADJUSTMENT row carries the net change; the position becomes VOIDED. Refused when
// the balance would end below zero (a profitable trade whose money was withdrawn cannot be undone) or the account is
// CLOSED. SUSPENDED is allowed. MANAGER files a request, BROKER_ADMIN executes (same rule as the open void).
// Batch D (owner 2026-10-21): the void stays VISIBLE to the client (history / deals list it as VOIDED, greyed) and the
// reversal's note names the ticket ("Void of #100003783: ...").
async function executeVoidClosed(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string },
  position: Awaited<ReturnType<typeof loadVoidablePosition>>
): Promise<VoidResult> {
  // claim first: a concurrent void stops here instead of reversing twice
  const claim = await tx.position.updateMany({ where: { id: position.id, status: "CLOSED" }, data: { status: "VOIDED" } });
  if (claim.count === 0) throw new PositionActionError("position was changed by another action, refresh and try again");
  await markDealsVoidedInTx(tx, position.id);
  const r = await reverseClosedTradeInTx(tx, params.brokerId, position, { splitSwap: false, note: `Void of #${position.ticket}: reverses its result, commission and swap` });

  const updated = await tx.position.findUniqueOrThrow({ where: { id: position.id } });
  await tx.auditLog.create({
    data: {
      brokerId: params.brokerId,
      actorAdminId: params.adminId,
      action: "CLOSED_TRADE_VOID",
      entityType: "Position",
      entityId: position.id,
      oldValue: { status: "CLOSED", balance: r.balanceBefore.toString(), credit: r.creditBefore.toString(), realizedPnl: position.realizedPnl?.toString() ?? null },
      newValue: {
        status: "VOIDED",
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        side: position.side,
        volume: position.volume.toString(),
        reversalAmount: r.reversalAmount.toString(),
        creditRestored: r.creditUsed.toString(),
        balanceAfter: r.balanceAfter.toString(),
      },
    },
  });
  return { kind: "VOID", accountId: position.accountId, position: updated, reversalAmount: r.reversalAmount, balanceBefore: r.balanceBefore, balanceAfter: r.balanceAfter };
}

/// The money half of a closed-trade void, shared with delete. The reversal = -(commission + P/L + credit used + write-off
/// booked against the position) - its swap; refused below a zero balance. `splitSwap` (delete): the swap part is booked as
/// its own SWAP row instead of inside the ADJUSTMENT, so that once the trade's rows are hidden from the client the hidden
/// rows add up to zero and the swap the client was charged for it comes back on the swap line (lib/account-summary.ts).
async function reverseClosedTradeInTx(
  tx: Tx,
  brokerId: string,
  position: { id: string; accountId: string; swap: Prisma.Decimal; ticket: number },
  opts: { splitSwap: boolean; note: string }
) {
  const rows = await tx.transaction.groupBy({
    by: ["type"],
    where: { accountId: position.accountId, referenceType: "Position", referenceId: position.id, status: "COMPLETED", type: { in: ["COMMISSION", "TRADE_PNL", "CREDIT", "NEGATIVE_BALANCE_PROTECTION"] } },
    _sum: { amount: true },
  });
  const sum = (t: string) => rows.find((r) => r.type === t)?._sum.amount ?? new Prisma.Decimal(0);
  const creditUsed = sum("CREDIT");
  // every one of these rows added its amount to the balance (credit used and the write-off included)
  const booked = sum("COMMISSION").add(sum("TRADE_PNL")).add(creditUsed).add(sum("NEGATIVE_BALANCE_PROTECTION"));
  const swapRefund = position.swap.neg();
  const reversalAmount = booked.neg().add(swapRefund);

  const funds = await lockAccountFunds(tx, position.accountId);
  const balanceBefore = funds.balance;
  const balanceAfter = balanceBefore.add(reversalAmount);
  if (balanceAfter.isNegative()) {
    throw new PositionActionError(`cannot reverse: the balance would go below zero (balance ${balanceBefore.toFixed(2)}, reversal ${reversalAmount.toFixed(2)})`);
  }

  await tx.account.update({
    where: { id: position.accountId },
    data: creditUsed.gt(0) ? { balance: balanceAfter, credit: funds.credit.add(creditUsed) } : { balance: balanceAfter },
  });
  const adjustment = opts.splitSwap ? booked.neg() : reversalAmount;
  let running = balanceBefore;
  if (!adjustment.isZero()) {
    await tx.transaction.create({
      data: {
        brokerId, accountId: position.accountId, type: "ADJUSTMENT", status: "COMPLETED", amount: adjustment,
        balanceBefore: running, balanceAfter: running.add(adjustment), referenceType: "Position", referenceId: position.id, note: opts.note,
      },
    });
    running = running.add(adjustment);
  }
  if (opts.splitSwap && !swapRefund.isZero()) {
    await tx.transaction.create({
      data: {
        brokerId, accountId: position.accountId, type: "SWAP", status: "COMPLETED", amount: swapRefund,
        balanceBefore: running, balanceAfter: running.add(swapRefund), referenceType: "Position", referenceId: position.id,
        note: `Swap of #${position.ticket} returned (trade deleted)`,
      },
    });
  }
  return { reversalAmount, swapRefund, creditUsed, balanceBefore, balanceAfter, creditBefore: funds.credit };
}

// ---------- Delete ----------
// Batch D (owner decision 2026-10-21): DELETE = the money reversed AND the trade invisible to the client.
//   1. a CLOSED trade is reversed exactly like a void (reverseClosedTradeInTx; refused below a zero balance or on a CLOSED
//      account) and becomes VOIDED, its deals marked voided; an already VOIDED trade is not reversed again. The swap
//      part of the reversal is its own SWAP row (see reverseClosedTradeInTx); a trade voided earlier carried its swap
//      inside the void's ADJUSTMENT, so that part is moved out the same way (a hidden ADJUSTMENT back, a visible SWAP
//      refund: the balance does not move).
//   2. the position is soft-deleted (deletedAt / deletedByAdminId / deleteReason, as before) and every ledger row that
//      references it (TRADE_PNL, COMMISSION, CREDIT, write-off, the void / delete ADJUSTMENT) gets hiddenForPositionId:
//      the client's history, deals, transactions, statement and summary leave the trade and its money out; the
//      backoffice still lists them (marked deleted).
// OPEN positions are refused: hiding a live position would strand it. Void or close it first. Nothing is ever physically
// removed, but there is no undelete either.
export type DeleteResult = { kind: "DELETE"; accountId: string; position: Position; reversalAmount: Prisma.Decimal; hiddenRows: number };

export async function executeDelete(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string; reason: string }
): Promise<DeleteResult> {
  const position = await tx.position.findUnique({
    where: { id: params.positionId },
    include: { account: { select: { accountNumber: true, status: true } }, symbol: { select: { name: true } } },
  });
  if (!position || position.brokerId !== params.brokerId) throw new PositionActionError("position not found");
  if (position.status === "OPEN") throw new PositionActionError("cannot delete an open position, void or close it first");
  if (position.deletedAt) throw new PositionActionError("position already deleted");

  let reversalAmount = new Prisma.Decimal(0);
  let swapRefund = new Prisma.Decimal(0);
  let balanceAfter: Prisma.Decimal | null = null;
  const wasStatus = position.status;
  if (position.status === "CLOSED") {
    if (position.account.status === "CLOSED") throw new PositionActionError("account is closed");
    const claim = await tx.position.updateMany({ where: { id: position.id, status: "CLOSED", deletedAt: null }, data: { status: "VOIDED" } });
    if (claim.count === 0) throw new PositionActionError("position was changed by another action, refresh and try again");
    await markDealsVoidedInTx(tx, position.id);
    const r = await reverseClosedTradeInTx(tx, params.brokerId, position, { splitSwap: true, note: `Delete of #${position.ticket}: reverses its result and commission` });
    reversalAmount = r.reversalAmount;
    swapRefund = r.swapRefund;
    balanceAfter = r.balanceAfter;
  } else if (!position.swap.isZero()) {
    // already VOIDED: its money is back; move the swap refund out of the void's ADJUSTMENT (net zero on the balance)
    swapRefund = position.swap.neg();
    const balance = await lockAccountBalance(tx, position.accountId);
    await tx.transaction.create({
      data: {
        brokerId: params.brokerId, accountId: position.accountId, type: "ADJUSTMENT", status: "COMPLETED", amount: swapRefund.neg(),
        balanceBefore: balance, balanceAfter: balance.sub(swapRefund), referenceType: "Position", referenceId: position.id,
        note: `Delete of #${position.ticket}: swap refund moved to the swap line`,
      },
    });
    await tx.transaction.create({
      data: {
        brokerId: params.brokerId, accountId: position.accountId, type: "SWAP", status: "COMPLETED", amount: swapRefund,
        balanceBefore: balance.sub(swapRefund), balanceAfter: balance, referenceType: "Position", referenceId: position.id,
        note: `Swap of #${position.ticket} returned (trade deleted)`,
      },
    });
  }

  // hide every ledger row of the trade from the client, except the swap refund (a SWAP row: see the header)
  const hidden = await tx.transaction.updateMany({
    where: { accountId: position.accountId, referenceType: "Position", referenceId: position.id, type: { not: "SWAP" } },
    data: { hiddenForPositionId: position.id },
  });
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
      oldValue: { deletedAt: null, status: wasStatus },
      newValue: {
        accountNumber: position.account.accountNumber,
        symbol: position.symbol.name,
        ticket: position.ticket,
        status: "VOIDED",
        reason: params.reason,
        reversalAmount: reversalAmount.toString(),
        swapRefund: swapRefund.toString(),
        hiddenRows: hidden.count,
        ...(balanceAfter ? { balanceAfter: balanceAfter.toString() } : {}),
      },
    },
  });

  return { kind: "DELETE", accountId: position.accountId, position: updated, reversalAmount, hiddenRows: hidden.count };
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
const ACTION_WORD: Record<PositionActionType, string> = { DELETE: "delete", VOID: "void", REVERSE_IN_PLACE: "reverse", REVERSE_CLOSE_REOPEN: "reverse" };
const ALREADY_WAITING = (t: PositionActionType | null) => `a ${t ? ACTION_WORD[t] + " " : ""}request for this trade is already waiting for approval`;

export async function requestPositionAction(
  tx: Tx,
  params: { brokerId: string; positionId: string; adminId: string; actionType: PositionActionType; reason: string | null }
) {
  // web5 (issues.md 71): never file a request nobody can approve (a manager-only broker) -- refused at filing
  if (!(await hasEligibleApprover(tx, params.brokerId, params.adminId, "ACCOUNT_FINANCE"))) throw new PositionActionError(NEEDS_BROKER_ADMIN);
  // Same-shape existence/status guard as the direct-execute path, so a
  // MANAGER gets the same "not found"/"not open" error at request time
  // instead of only discovering it once a checker tries to approve.
  if (params.actionType === "DELETE") {
    const position = await tx.position.findUnique({ where: { id: params.positionId } });
    if (!position || position.brokerId !== params.brokerId) throw new PositionActionError("position not found");
    if (position.status === "OPEN") throw new PositionActionError("cannot delete an open position, void or close it first");
    if (position.deletedAt) throw new PositionActionError("position already deleted");
  } else if (params.actionType === "VOID") {
    await loadVoidablePosition(tx, params.brokerId, params.positionId);
  } else {
    await loadOpenPosition(tx, params.brokerId, params.positionId);
  }

  // Batch D: one waiting request per position (a second one is refused, whatever its type). The partial unique index
  // PositionActionRequest_one_pending_per_position backs this against two managers filing at the same moment.
  const waiting = await tx.positionActionRequest.findFirst({ where: { positionId: params.positionId, status: "PENDING" }, select: { actionType: true } });
  if (waiting) throw new PositionActionError(ALREADY_WAITING(waiting.actionType));
  let request;
  try {
    request = await tx.positionActionRequest.create({
      data: {
        brokerId: params.brokerId,
        positionId: params.positionId,
        actionType: params.actionType,
        requestedByAdminId: params.adminId,
        reason: params.reason,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new PositionActionError(ALREADY_WAITING(null));
    throw err;
  }
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
