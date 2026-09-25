import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { resolveCloseByPair } from "@/lib/close-by";
import { executeAdminCloseInTx } from "@/lib/position-actions";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";
import { publishTradingEvent } from "@/lib/nats";
import { recordDealerActivity } from "@/lib/dealer-activity";
import { cancelPendingClose } from "@/lib/queued-close";
import { isDealingManagedAccount } from "@/lib/dealing-routing";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Dealer Close By (backoffice 1.0.19, 2026-09-24): the desk closes two opposite positions of ONE client account against
// each other -- same pairing, session check and single mid price as the trader's own close-by (lib/close-by.ts
// resolveCloseByPair), but each leg goes through the audited admin close (executeAdminCloseInTx: status + volume guard,
// negative-balance protection, TRADE_PNL, closedByAdminId, MANUAL_POSITION_CLOSE), both legs in ONE transaction so a
// lost race never leaves one leg closed against a leg that did not happen. An admin close bypasses the dealer queue,
// like app/api/manage/positions/[id]/close. Follow-ups after commit, per leg: mirror, coverage, a queued client close
// made moot, dealer activity; one PositionsClosed event for the pair.
export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // owner decision 2026-09-25 (audit Batch 4): CLIENT_TRADING -- BROKER_ADMIN, or a MANAGER granted it. No second admin
  // (dealing needs speed); every action writes its audit row.
  if (await forbidUnlessBrokerAdminOrPermission(session, "CLIENT_TRADING")) {
    return NextResponse.json({ error: "forbidden", permission: "CLIENT_TRADING", permissionLabel: PERMISSION_LABELS.CLIENT_TRADING }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const positionId = typeof body?.positionId === "string" ? body.positionId : "";
  const againstPositionId = typeof body?.againstPositionId === "string" ? body.againstPositionId : "";
  if (!positionId || !againstPositionId) {
    return NextResponse.json({ error: "positionId and againstPositionId are required" }, { status: 400 });
  }

  const first = await prisma.position.findUnique({ where: { id: positionId }, select: { brokerId: true, accountId: true } });
  if (!first || first.brokerId !== brokerId) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }
  // both legs must be this client's (resolveCloseByPair checks the second against the first's account)
  const pair = await resolveCloseByPair(prisma, { accountId: first.accountId, brokerId, positionId, againstPositionId });
  if (!pair.ok) {
    const status = pair.error === "position not found" ? 404 : 400;
    return NextResponse.json({ error: pair.error, ...(pair.nextOpenAt ? { nextOpenAt: pair.nextOpenAt } : {}) }, { status });
  }
  const { a, b, closePrice, closeVolume } = pair;

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: first.accountId },
    select: { accountNumber: true, fullName: true, group: { select: { groupType: true, dealingMode: true, forceDealingMode: true } } },
  });

  const legs = [a, b] as const;
  const outcome = await prisma.$transaction(async (tx) => {
    const results = [];
    for (const p of legs) {
      const r = await executeAdminCloseInTx(tx, {
        brokerId,
        adminId: session.adminId,
        position: { id: p.id, accountId: p.accountId, side: p.side, openPrice: p.openPrice, volume: p.volume, symbol: { name: p.symbol.name, contractSize: p.symbol.contractSize }, account: { accountNumber: account.accountNumber } },
        closePrice,
        closeVolume,
      });
      // throwing rolls the first leg back too: never one leg without the other
      if (!r.closed) throw new CloseByRaced();
      results.push(r);
    }
    return results;
  }).catch((err) => {
    if (err instanceof CloseByRaced) return null;
    throw err;
  });
  if (!outcome) {
    return NextResponse.json({ error: "one of the positions was closed or changed by another action, refresh and try again" }, { status: 409 });
  }

  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true } });
  const isDealingGroup = isDealingManagedAccount({
    group: account.group,
    brokerDealingModeOn: !!broker?.dealingModeAt,
    dealingDeskAutoFillOn: !!broker?.dealingDeskAutoFillAt,
  });
  for (const [i, p] of legs.entries()) {
    const partial = closeVolume.lt(p.volume);
    await mirror.onClose(prisma, { positionId: p.id, brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: p.volume, closePrice }).catch((err) => console.error("mirror.onClose failed (dealer close-by)", err));
    await coverage.onClose(prisma, { positionId: p.id, brokerId, closedLots: closeVolume, sourceVolumeBeforeClose: p.volume, reason: "manual" }).catch((err) => console.error("coverage.onClose failed (dealer close-by)", err));
    if (!partial) await cancelPendingClose(prisma, p.id, "position closed by admin").catch((err) => console.error("cancelPendingClose failed", err));
    await recordDealerActivity(prisma, {
      brokerId,
      accountId: p.accountId,
      accountNumber: account.accountNumber,
      accountFullName: account.fullName,
      isDealingGroup,
      action: "POSITION_CLOSED",
      symbol: p.symbol.name,
      side: p.side,
      volume: closeVolume.toString(),
      values: { closePrice: closePrice.toString(), partial, realizedPnl: outcome[i].realizedPnl.toString(), origin: "admin_close_by", against: legs[1 - i].id },
      positionId: p.id,
    });
  }
  await publishTradingEvent("PositionsClosed", { broker_id: brokerId, account_id: first.accountId, position_ids: [a.id, b.id], count: 2 });

  return NextResponse.json({
    ok: true,
    closeVolume: closeVolume.toString(),
    closePrice: closePrice.toString(),
    positionAId: a.id,
    positionBId: b.id,
    realizedPnlA: outcome[0].realizedPnl.toString(),
    realizedPnlB: outcome[1].realizedPnl.toString(),
  });
}

class CloseByRaced extends Error {}
