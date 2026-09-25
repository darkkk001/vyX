import { NextRequest, NextResponse } from "next/server";
import { publishTradingEvent } from "@/lib/nats";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { executeIbPayout, IbPayoutError } from "@/lib/ib-payout";
import { balanceAdjustmentNeedsApproval, requestBalanceAdjustment, pendingIbCommission, BalanceAdjustmentError } from "@/lib/balance-adjustment";

// Two things this route can do to a relationship, both BROKER_ADMIN by
// default, delegatable via IB_PAYOUTS (see lib/permissions.ts):
// - { commissionType?, commissionRate? } -- edit the rate/type (fixing a
//   typo, doesn't touch money).
// - { action: "PAY" } -- pay out the currently-pending commission, moving
//   real balance through the Transaction ledger. Never both in one call.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.ibRelationship.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "relationship not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);

  if (body?.action === "PAY") {
    // Audit 2026-09-24 (money): the same maker-checker rule as a balance adjustment -- a MANAGER (IB_PAYOUTS) files
    // the payout for a second admin's approval (lib/balance-adjustment.ts, kind IB_PAYOUT); BROKER_ADMIN pays
    // directly. The amount is recomputed at execution either way (lib/ib-payout.ts).
    if (balanceAdjustmentNeedsApproval(session!.role as "MANAGER" | "BROKER_ADMIN")) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          const pending = await pendingIbCommission(tx, id);
          if (pending.lte(0)) throw new BalanceAdjustmentError("no pending commission to pay");
          return requestBalanceAdjustment(tx, {
            brokerId, accountId: existing.ibAccountId, amount: pending, note: "IB commission payout", adminId: session!.adminId, kind: "IB_PAYOUT", ibRelationshipId: id,
          });
        });
        return NextResponse.json({ pending: true, requestId: created.id, amount: created.amount.toString() }, { status: 202 });
      } catch (e) {
        if (e instanceof BalanceAdjustmentError) return NextResponse.json({ error: e.message }, { status: 400 });
        throw e;
      }
    }
    try {
      const result = await prisma.$transaction((tx) => executeIbPayout(tx, { relationshipId: id, brokerId, adminId: session!.adminId }));

      // the IB's terminal refreshes at once (after the commit; best-effort, never fails the payout)
      await publishTradingEvent("BalanceChanged", { account_id: result.transaction.accountId, broker_id: brokerId, transaction_id: result.transaction.id }).catch(() => {});

      return NextResponse.json({
        id,
        paid: result.transaction.amount.toString(),
        balanceAfter: result.transaction.balanceAfter!.toString(),
        lastPayoutAt: result.lastPayoutAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof IbPayoutError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  // Plain field edit
  const data: Prisma.IbRelationshipUpdateInput = {};
  if (body?.commissionType === "PER_LOT" || body?.commissionType === "PERCENTAGE") {
    data.commissionType = body.commissionType;
  }
  if (body?.commissionRate !== undefined) {
    let rate: Prisma.Decimal;
    try {
      rate = new Prisma.Decimal(String(body.commissionRate));
    } catch {
      return NextResponse.json({ error: "invalid commissionRate" }, { status: 400 });
    }
    if (rate.lte(0)) {
      return NextResponse.json({ error: "commissionRate must be positive" }, { status: 400 });
    }
    data.commissionRate = rate;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.ibRelationship.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "IB_RELATIONSHIP_UPDATED",
        entityType: "IbRelationship",
        entityId: id,
        oldValue: { commissionType: existing.commissionType, commissionRate: existing.commissionRate.toString() },
        newValue: { commissionType: result.commissionType, commissionRate: result.commissionRate.toString() },
      },
    });
    return result;
  });

  return NextResponse.json({
    id: updated.id,
    commissionType: updated.commissionType,
    commissionRate: updated.commissionRate.toString(),
  });
}
