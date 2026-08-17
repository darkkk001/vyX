import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computePendingCommission } from "@/lib/commission";

// Two things this route can do to a relationship, both BROKER_ADMIN only:
// - { commissionType?, commissionRate? } -- edit the rate/type (fixing a
//   typo, doesn't touch money).
// - { action: "PAY" } -- pay out the currently-pending commission, moving
//   real balance through the Transaction ledger. Never both in one call.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
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
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Recompute inside the transaction -- never trust a client-supplied
        // amount, and a position could close between the list render and
        // this click.
        const pending = await computePendingCommission(tx, existing);
        if (pending.lte(0)) {
          throw new Error("NOTHING_PENDING");
        }

        const ibAccount = await tx.account.findUniqueOrThrow({ where: { id: existing.ibAccountId } });
        const balanceBefore = ibAccount.balance;
        const balanceAfter = balanceBefore.add(pending);

        await tx.account.update({ where: { id: existing.ibAccountId }, data: { balance: balanceAfter } });

        const transaction = await tx.transaction.create({
          data: {
            brokerId,
            accountId: existing.ibAccountId,
            type: "COMMISSION",
            status: "COMPLETED",
            amount: pending,
            balanceBefore,
            balanceAfter,
            referenceType: "IbRelationship",
            referenceId: existing.id,
            reviewedByAdminId: session!.adminId,
          },
        });

        const updated = await tx.ibRelationship.update({
          where: { id },
          data: { lastPayoutAt: new Date() },
        });

        await tx.auditLog.create({
          data: {
            brokerId,
            actorAdminId: session!.adminId,
            action: "IB_COMMISSION_PAID",
            entityType: "IbRelationship",
            entityId: id,
            newValue: {
              amount: pending.toString(),
              transactionId: transaction.id,
              balanceBefore: balanceBefore.toString(),
              balanceAfter: balanceAfter.toString(),
            },
          },
        });

        return { transaction, lastPayoutAt: updated.lastPayoutAt };
      });

      return NextResponse.json({
        id,
        paid: result.transaction.amount.toString(),
        balanceAfter: result.transaction.balanceAfter.toString(),
        lastPayoutAt: result.lastPayoutAt!.toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "NOTHING_PENDING") {
        return NextResponse.json({ error: "no pending commission to pay" }, { status: 400 });
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
