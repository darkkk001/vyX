import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { provisionAccount } from "@/lib/account-provisioning";
import { getLivePriceRow } from "@/lib/live-price";
import { closePositionInTx } from "@/lib/position-close";
import { computeProportionalCloseVolume } from "@/lib/mirror";
import { createNotification } from "@/lib/notifications";
import { publishTradingEvent } from "@/lib/nats";
import { emitPositionClosedActivity } from "@/lib/dealer-activity";
import { computeRealizedPnl } from "@/lib/trading";

// Dealer coverage (B-book hedging). A broker hedges a client's B-book
// position by clicking BOOK NOW (app/api/manage/positions/[id]/book),
// which mirrors the SAME-side leg onto one system account so the broker's
// book nets flat: client BUY 1 lot => broker is effectively short 1 lot;
// a coverage BUY 1 lot cancels that, so a price move that owes the client
// is exactly offset by the coverage account's gain (see the book route's
// own comment for the P&L walk-through).
//
// The coverage account lives in a groupType=COVERAGE system group. Raw
// pricing (no spread markup, no commission) isn't enforced by the group
// config -- the book route creates the hedge leg directly at the live
// market price with zero commission, deliberately bypassing
// resolveSymbolPricing/chargeCommission so the hedge reflects the real
// market rather than re-charging the broker its own markup.

// Stable per-broker name for the coverage group (Group is unique on
// [brokerId, name]) -- lets ensureCoverageGroup be idempotent.
export const COVERAGE_GROUP_NAME = "Dealer Coverage (system)";

async function ensureCoverageGroup(brokerId: string): Promise<{ id: string; leverage: number }> {
  const existing = await prisma.group.findFirst({
    where: { brokerId, category: "COVERAGE" },
    select: { id: true, leverage: true },
  });
  if (existing) return existing;
  try {
    const created = await prisma.group.create({
      data: {
        brokerId,
        name: COVERAGE_GROUP_NAME,
        // Both axes, explicitly: COVERAGE routing (books A_BOOK -- a
        // coverage position is the broker's real market-facing exposure)
        // and live money only. groupType stays as this release's shadow.
        category: "COVERAGE",
        modeRestriction: "LIVE_ONLY",
        groupType: "COVERAGE",
        // High leverage: the coverage account is the broker's own hedge
        // book, never margin-called the way a client is -- a low cap would
        // only risk a spurious stop-out on the broker's own hedge.
        leverage: 500,
        isDefault: false,
      },
      select: { id: true, leverage: true },
    });
    return created;
  } catch {
    // Lost a create race on the unique [brokerId, name] -- re-read the
    // winner.
    const found = await prisma.group.findFirst({
      where: { brokerId, category: "COVERAGE" },
      select: { id: true, leverage: true },
    });
    if (found) return found;
    throw new Error("failed to provision coverage group");
  }
}

export type CoverageAccount = { accountId: string; groupId: string };

// Returns the broker's coverage account, provisioning the COVERAGE group
// and a fresh system Account on first use and stamping
// Broker.coverageAccountId. Idempotent and safe to call on every BOOK NOW
// (the common case is a single findUnique that returns the existing id).
export async function ensureCoverageAccount(
  brokerId: string,
  createdByAdminId: string | null
): Promise<CoverageAccount> {
  const broker = await prisma.broker.findUniqueOrThrow({
    where: { id: brokerId },
    select: { coverageAccountId: true },
  });
  if (broker.coverageAccountId) {
    const acct = await prisma.account.findUnique({
      where: { id: broker.coverageAccountId },
      select: { id: true, groupId: true },
    });
    // Pointer set and the account still exists -- the steady state.
    if (acct) return { accountId: acct.id, groupId: acct.groupId ?? (await ensureCoverageGroup(brokerId)).id };
    // Dangling pointer (account deleted) -- fall through and re-provision.
  }

  const group = await ensureCoverageGroup(brokerId);

  // A real, functional LIVE account, but system-owned: a random
  // credential nobody logs in with (the account is only ever written by
  // the book route, never by a trader). email carries the broker id to
  // stay unique across brokers on the same platform.
  const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
  const account = await provisionAccount({
    brokerId,
    fullName: "Dealer Coverage",
    email: `coverage.${brokerId}@system.vyxtrader.internal`,
    passwordHash,
    accountMode: "LIVE",
    accountTypeId: null,
    // The one caller permitted into a COVERAGE group.
    allowCoverage: true,
    currency: "USD",
    leverage: group.leverage,
    groupId: group.id,
    initialBalance: new Prisma.Decimal(0),
    country: null,
    phone: null,
    dateOfBirth: null,
    clientId: null,
    createdByAdminId,
  });

  // Claim the pointer only if still unset -- a concurrent BOOK NOW may
  // have provisioned and claimed first. updateMany (not update) so the
  // where-guard makes this a no-op instead of an error when we lose.
  const claim = await prisma.broker.updateMany({
    where: { id: brokerId, coverageAccountId: null },
    data: { coverageAccountId: account.id },
  });
  if (claim.count === 0) {
    // A racing caller won the pointer. Ours is a harmless inert extra
    // account (0 balance, no positions, no login) -- use the winner.
    const winner = await prisma.broker.findUniqueOrThrow({
      where: { id: brokerId },
      select: { coverageAccountId: true },
    });
    if (winner.coverageAccountId && winner.coverageAccountId !== account.id) {
      const acct = await prisma.account.findUnique({
        where: { id: winner.coverageAccountId },
        select: { id: true, groupId: true },
      });
      if (acct) return { accountId: acct.id, groupId: acct.groupId ?? group.id };
    }
  }

  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: createdByAdminId,
      action: "COVERAGE_ACCOUNT_PROVISIONED",
      entityType: "Account",
      entityId: account.id,
      newValue: { accountNumber: account.accountNumber, groupId: group.id },
    },
  });

  return { accountId: account.id, groupId: group.id };
}

// ---------------------------------------------------------------------------
// Coverage follow-through (2026-09-22). BOOK NOW stamps
// Position.coveragePositionId on the client position, and until now nothing
// ever read it: a client closing a booked position left the hedge leg open
// on the coverage account (an orphan the dealer had to notice and close by
// hand), and a hedge leg closing on its own (stop-out, manual) left the
// client position flagged `covered` with no hedge behind it. onClose is
// called after EVERY committed close in this codebase, right beside
// mirror.onClose, and does the follow-through for both directions:
//
//   client leg closed  -> close the linked coverage leg (proportionally on a
//                         partial) at the live market, zero commission.
//   coverage leg closed -> release the client position (covered = false,
//                          link cleared) so it is back in the Smart Dealer
//                          Manager's unbooked list, and tell the dealer why.
//
// Idempotent: a leg already closed (the dealer closed coverage before the
// client did) is a no-op -- there is nothing left to follow.
// ---------------------------------------------------------------------------

export type CoverageCloseEvent = {
  positionId: string;
  brokerId: string;
  closedLots: Prisma.Decimal;
  sourceVolumeBeforeClose: Prisma.Decimal;
  // why the leg closed, for the dealer-facing wording; "manual" covers the
  // trader's / dealer's own close, "stop_out" / "sl_tp" the risk monitor
  reason?: "manual" | "stop_out" | "sl_tp" | "void" | "reverse";
  marginLevel?: string;
};

type Db = PrismaClient | Prisma.TransactionClient;

export async function onClose(db: Db, ev: CoverageCloseEvent): Promise<void> {
  const closed = await db.position.findUnique({
    where: { id: ev.positionId },
    select: {
      id: true,
      ticket: true,
      accountId: true,
      side: true,
      volume: true,
      status: true,
      coveragePositionId: true,
      symbol: { select: { name: true } },
      // account group + broker desk flags: whether THIS client's closes are dealer-reviewed
      account: { select: { accountNumber: true, group: { select: { dealingMode: true, forceDealingMode: true, groupType: true } } } },
      broker: { select: { dealingModeAt: true, dealingDeskAutoFillAt: true } },
      // the client position this leg hedges (self-relation back side; unique in practice, a list in the schema)
      coveredClientPos: { select: { id: true, ticket: true, status: true, accountId: true, account: { select: { accountNumber: true } } }, take: 1 },
    },
  });
  if (!closed) return;

  // (a) a coverage leg closed -> release the client position it was hedging
  if (closed.coveredClientPos.length > 0) {
    const client = closed.coveredClientPos[0];
    if (client.status === "OPEN") {
      await db.position.updateMany({ where: { id: client.id, coveragePositionId: closed.id }, data: { covered: false, coveragePositionId: null } });
      await db.auditLog.create({
        data: {
          brokerId: ev.brokerId,
          action: "POSITION_COVERAGE_RELEASED",
          entityType: "Position",
          entityId: client.id,
          oldValue: { coveragePositionId: closed.id, coverageTicket: closed.ticket },
          newValue: { covered: false, reason: ev.reason ?? "manual" },
        },
      });
      const why =
        ev.reason === "stop_out"
          ? `stopped out${ev.marginLevel ? ` at margin level ${ev.marginLevel}%` : ""}: the coverage account ran out of balance`
          : ev.reason === "sl_tp"
            ? "closed by its own SL / TP"
            : "closed";
      // the dealer must know the client leg is exposed again: bell + feed
      await createNotification(db, {
        brokerId: ev.brokerId,
        type: ev.reason === "stop_out" ? "COVERAGE_STOP_OUT" : "COVERAGE_RELEASED",
        title: ev.reason === "stop_out" ? `Coverage stop-out: position #${closed.ticket} closed` : `Coverage leg #${closed.ticket} closed: client position unhedged`,
        body: `Coverage ${closed.symbol.name} ${closed.side} ${closed.volume.toString()} (#${closed.ticket}) ${why}. Client ${client.account.accountNumber} #${client.ticket} ${closed.symbol.name} is UNHEDGED and back in the Smart Dealer Manager${ev.reason === "stop_out" ? ". Fund the coverage account before booking it again" : ""}.`,
        entityType: "Position",
        entityId: client.id,
      });
    }
    return;
  }

  // (b) a client leg closed -> follow with the coverage leg
  if (!closed.coveragePositionId) return;
  const leg = await db.position.findUnique({
    where: { id: closed.coveragePositionId },
    include: { symbol: { select: { name: true, contractSize: true, digits: true } } },
  });   // leg.autoHedged decides who closes it, below
  if (!leg || leg.status !== "OPEN") return; // the dealer already closed coverage -- nothing to follow

  const closeVolume = computeProportionalCloseVolume(ev.closedLots, ev.sourceVolumeBeforeClose, leg.volume);
  // the tx-aware reader (like mirror.onClose): the latest known price for the leg's symbol
  const live = await getLivePriceRow(leg.symbol.name, db);

  // WHO CLOSES THE LEG (2026-09-23) -- decided by who OPENED it, not by the desk's state right now:
  //   auto-hedged leg (the platform opened it, Position.autoHedged) -> it follows the client's close
  //                                                                    automatically, matched.
  //   dealer-booked leg (BOOK NOW)                                  -> the dealer closes it, from the
  //                                                                    Smart Dealer Manager.
  // This is what "symmetric with opening" means: whoever opened the hedge closes it. 1.0.14 keyed this
  // off whether the CLIENT was dealer-reviewed at the moment of the close, which broke symmetry the
  // moment the desk toggle moved between the open and the close (a leg the platform had opened could
  // end up waiting for a dealer, and one the dealer had booked could vanish under them).
  //
  // Note this branch is only reached when a leg EXISTS (the coveragePositionId check above). An
  // UNBOOKED position's close never gets here: it is governed solely by the dealer-review queue on the
  // close itself (lib/queued-close.ts), which is a separate switch and untouched by any of this.
  if (!leg.autoHedged) {
    const legPnl = live
      ? computeRealizedPnl({
          side: leg.side,
          openPrice: leg.openPrice,
          closePrice: leg.side === "BUY" ? live.bid : live.ask,
          volume: leg.volume,
          contractSize: leg.symbol.contractSize,
        })
      : null;
    const at = legPnl ? `${legPnl.gte(0) ? "+" : ""}${legPnl.toFixed(2)}` : "unpriced";
    await db.auditLog.create({
      data: {
        brokerId: ev.brokerId,
        action: "POSITION_COVERAGE_CLOSE_AWAITING_DEALER",
        entityType: "Position",
        entityId: leg.id,
        oldValue: { clientPositionId: closed.id, clientTicket: closed.ticket, clientClosedLots: ev.closedLots.toString() },
        newValue: { legTicket: leg.ticket, legPnl: legPnl?.toString() ?? null, reason: ev.reason ?? "manual", legOrigin: "dealer_booked" },
      },
    });
    await createNotification(db, {
      brokerId: ev.brokerId,
      type: "COVERAGE_CLOSE_AWAITING_DEALER",
      title: `Client closed #${closed.ticket}: coverage leg #${leg.ticket} is yours to close`,
      body: `Client ${closed.account.accountNumber} closed ${ev.closedLots.toString()} ${leg.symbol.name} (#${closed.ticket}). You booked that hedge by hand, so the coverage leg #${leg.ticket} (${leg.side} ${leg.volume.toString()}) was left OPEN and is at ${at} against that order. Close it from the Smart Dealer Manager when you are ready.`,
      entityType: "Position",
      entityId: leg.id,
    });
    return;
  }

  if (!live) {
    await createNotification(db, {
      brokerId: ev.brokerId,
      type: "COVERAGE_CLOSE_FAILED",
      title: `Coverage leg #${leg.ticket} NOT closed: no live price`,
      body: `Client ${closed.account.accountNumber} #${closed.ticket} closed ${ev.closedLots.toString()} ${leg.symbol.name}, but the coverage leg #${leg.ticket} could not be closed (no live ${leg.symbol.name} price). Close it from the Coverage Account panel.`,
      entityType: "Position",
      entityId: leg.id,
    });
    return;
  }
  const closePrice = leg.side === "BUY" ? live.bid : live.ask;
  const runInTx = (fn: (tx: Prisma.TransactionClient) => Promise<Awaited<ReturnType<typeof closePositionInTx>>>) =>
    "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db as Prisma.TransactionClient);
  const outcome = await runInTx((tx) =>
    closePositionInTx(tx, {
      position: {
        id: leg.id,
        accountId: leg.accountId,
        brokerId: leg.brokerId,
        side: leg.side,
        openPrice: leg.openPrice,
        volume: leg.volume,
        symbol: { contractSize: leg.symbol.contractSize },
      },
      closePrice,
      closeVolume,
      note: `Coverage auto-close (auto-hedged leg): client #${closed.ticket} closed ${ev.closedLots.toString()} of ${ev.sourceVolumeBeforeClose.toString()}`,
    })
  );
  if (!outcome.closed) return;
  await db.auditLog.create({
    data: {
      brokerId: ev.brokerId,
      action: "POSITION_COVERAGE_AUTO_CLOSED",
      entityType: "Position",
      entityId: leg.id,
      oldValue: { clientPositionId: closed.id, clientTicket: closed.ticket, clientClosedLots: ev.closedLots.toString() },
      newValue: { coverageClosedLots: closeVolume.toString(), closePrice: closePrice.toString(), realizedPnl: outcome.realizedPnl.toString(), partial: outcome.partial },
    },
  });
  await publishTradingEvent("PositionClosed", { position_id: leg.id, account_id: leg.accountId, broker_id: leg.brokerId, reason: "coverage_auto" }).catch((err) =>
    console.error("coverage onClose: publishTradingEvent failed", err)
  );
  await emitPositionClosedActivity(db, { positionId: leg.id, closePrice, closeVolume, partial: outcome.partial, realizedPnl: outcome.realizedPnl, closeReason: "ADMIN", origin: `coverage_auto_close:${closed.id}` });
}

// Stop-out / margin-call wording for the dealer (2026-09-22): the risk
// monitor closes and warns without ever telling the desk. A stop-out on the
// coverage account is the broker's own hedge evaporating, so it gets its
// own title; a client stop-out is a plain staff notification.
export async function notifyStopOut(
  db: Db,
  p: { brokerId: string; accountId: string; accountNumber: string; positionId: string; ticket: number; symbol: string; side: string; volume: string; marginLevel: string; stopOutLevel: string }
): Promise<void> {
  const broker = await db.broker.findUnique({ where: { id: p.brokerId }, select: { coverageAccountId: true } });
  const isCoverage = broker?.coverageAccountId === p.accountId;
  await createNotification(db, {
    brokerId: p.brokerId,
    type: isCoverage ? "COVERAGE_STOP_OUT" : "STOP_OUT",
    title: isCoverage ? `Coverage stop-out: position #${p.ticket} closed` : `Stop-out: ${p.accountNumber} #${p.ticket} closed`,
    body: isCoverage
      ? `The coverage account (${p.accountNumber}) hit stop-out at margin level ${p.marginLevel}% (limit ${p.stopOutLevel}%): ${p.symbol} ${p.side} ${p.volume} #${p.ticket} was force-closed. The coverage account has run out of balance. Fund it before booking again.`
      : `Account ${p.accountNumber} hit stop-out at margin level ${p.marginLevel}% (limit ${p.stopOutLevel}%): ${p.symbol} ${p.side} ${p.volume} #${p.ticket} was force-closed.`,
    entityType: "Position",
    entityId: p.positionId,
  });
}

export async function isCoverageAccount(db: Db, brokerId: string, accountId: string): Promise<boolean> {
  const broker = await db.broker.findUnique({ where: { id: brokerId }, select: { coverageAccountId: true } });
  return broker?.coverageAccountId === accountId;
}

// ---------------------------------------------------------------------------
// AUTO-HEDGE (2026-09-23). The desk's "nobody is booking by hand" mode: while the
// broker is in auto-fill AND auto-hedge is on, every DEALING-group fill is mirrored
// onto the coverage account at the SAME price in the same breath, and that leg
// closes with the client's close (onClose above, via Position.autoHedged).
//
// The two desk modes are mutually exclusive by construction:
//   review ON  -> the dealer accepts each order and books the hedge with BOOK NOW.
//                 autoFillOn is false here, so this function returns immediately.
//   review OFF -> orders auto-fill; with auto-hedge on the platform books the hedge.
// so a position can never be hedged twice, once by each.
//
// Called from every fill site beside mirror.onFill*, and it decides for itself
// whether it applies: a caller never has to know the desk's state.
//
// Same price as the client's fill, deliberately: the point of hedging in the same
// moment is that the two legs offset exactly. Re-reading a live price here would
// book the hedge a tick away from the trade it covers and leak that difference on
// every single trade. (BOOK NOW, minutes or hours later, correctly uses the live
// price -- there is no "same moment" to match by then.)
//
// Never throws: a hedge failure must not roll back or block the client's own fill,
// the same rule mirror.onFill follows. A failure is audited and notified so the desk
// can book it by hand rather than silently carrying unhedged risk.
// ---------------------------------------------------------------------------
export async function onFillAutoHedge(
  db: Db,
  ev: { positionId: string; brokerId: string; adminId?: string | null }
): Promise<void> {
  const broker = await db.broker.findUnique({
    where: { id: ev.brokerId },
    select: { autoHedgeAt: true, dealingDeskAutoFillAt: true, coverageAccountId: true },
  });
  // off, or the desk is in review (where the dealer books by hand)
  if (!broker?.autoHedgeAt || !broker.dealingDeskAutoFillAt) return;

  const position = await db.position.findUnique({
    where: { id: ev.positionId },
    include: {
      symbol: { select: { name: true, digits: true } },
      account: { select: { accountNumber: true, group: { select: { groupType: true } } } },
    },
  });
  if (!position || position.status !== "OPEN" || position.covered || position.deletedAt) return;
  // only the desk's own book: a DEALING-type group is the dealing desk's classification, and it is
  // the right signal HERE (unlike dealer-awareness, which asks whether review is on) precisely
  // because auto-fill has already turned review off for exactly these groups.
  if (position.account.group?.groupType !== "DEALING") return;
  // a coverage leg is A_BOOK and lives on the coverage account: never hedge the hedge
  if (position.bookType !== "B_BOOK") return;
  if (broker.coverageAccountId && position.accountId === broker.coverageAccountId) return;

  try {
    // Steady state: the pointer is already set, so resolve it through `db` -- ensureCoverageAccount
    // provisions through the global prisma client, which a caller running inside a transaction (and
    // any test that rolls one back) cannot see. Provisioning itself stays in that one place.
    let coverageAccountId = broker.coverageAccountId;
    if (coverageAccountId) {
      const acct = await db.account.findUnique({ where: { id: coverageAccountId }, select: { id: true } });
      if (!acct) coverageAccountId = null;   // dangling pointer: re-provision below
    }
    if (!coverageAccountId) coverageAccountId = (await ensureCoverageAccount(ev.brokerId, ev.adminId ?? null)).accountId;
    const coverage = { accountId: coverageAccountId };
    if (position.accountId === coverage.accountId) return;
    const fillPrice = position.openPrice;

    const runInTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      "$transaction" in db ? (db as PrismaClient).$transaction(fn) : fn(db as Prisma.TransactionClient);

    const made = await runInTx(async (tx) => {
      // re-check inside the transaction: two fills of the same position can't both hedge it
      const fresh = await tx.position.findUnique({ where: { id: position.id }, select: { covered: true, status: true } });
      if (!fresh || fresh.covered || fresh.status !== "OPEN") return null;
      const order = await tx.order.create({
        data: {
          brokerId: ev.brokerId,
          accountId: coverage.accountId,
          symbolId: position.symbolId,
          side: position.side,
          type: "MARKET",
          volume: position.volume,
          requestedPrice: fillPrice,
          idempotencyKey: `coverage_autohedge_${position.id}`,
          status: "FILLED",
          source: "ADMIN",
          filledPrice: fillPrice,
          filledAt: new Date(),
        },
      });
      const legPosition = await tx.position.create({
        data: {
          brokerId: ev.brokerId,
          accountId: coverage.accountId,
          symbolId: position.symbolId,
          originOrderId: order.id,
          // SAME side as the client, like BOOK NOW: a B-book broker holds the opposite of its
          // client, so matching the client's side on the coverage account nets the book flat.
          side: position.side,
          volume: position.volume,
          openPrice: fillPrice,
          bookType: "A_BOOK",
          autoHedged: true,
        },
      });
      await tx.position.update({
        where: { id: position.id },
        data: { covered: true, coveredAt: new Date(), coveragePositionId: legPosition.id },
      });
      await tx.auditLog.create({
        data: {
          brokerId: ev.brokerId,
          action: "POSITION_COVERAGE_AUTO_HEDGED",
          entityType: "Position",
          entityId: position.id,
          newValue: {
            clientPositionId: position.id,
            clientTicket: position.ticket,
            coveragePositionId: legPosition.id,
            coverageTicket: legPosition.ticket,
            coverageAccountId: coverage.accountId,
            symbol: position.symbol.name,
            side: position.side,
            volume: position.volume.toString(),
            bookPrice: fillPrice.toString(),
          },
        },
      });
      return { order, legPosition, coverageAccountId: coverage.accountId };
    });
    if (!made) return;

    await publishTradingEvent("OrderFilled", {
      order_id: made.order.id,
      account_id: made.coverageAccountId,
      broker_id: ev.brokerId,
      price: fillPrice.toString(),
      volume: position.volume.toString(),
      remaining_volume: "0",
    }).catch((err) => console.error("auto-hedge: publishTradingEvent failed", err));
  } catch (err) {
    console.error("auto-hedge failed", err);
    // the client's trade stands; the desk is told it is carrying this one unhedged
    await createNotification(db, {
      brokerId: ev.brokerId,
      type: "COVERAGE_AUTO_HEDGE_FAILED",
      title: `Auto-hedge failed: #${position.ticket} is UNHEDGED`,
      body: `Auto-hedge could not open the coverage leg for ${position.account.accountNumber} ${position.symbol.name} ${position.side} ${position.volume.toString()} (#${position.ticket}). The client's trade is open and unhedged. Book it by hand from the Smart Dealer Manager.`,
      entityType: "Position",
      entityId: position.id,
    }).catch(() => {});
  }
}
