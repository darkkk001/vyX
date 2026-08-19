import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { computePendingCommission } from "@/lib/commission";

// Finance-adjacent (moves real balance on payout) -- BROKER_ADMIN by
// default, same carve-out as Funds/KYC (AdminRole.MANAGER's own schema
// comment: "not KYC/finance") -- delegatable via IB_PAYOUTS (see
// lib/permissions.ts).
async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const relationships = await prisma.ibRelationship.findMany({
    where: { brokerId },
    include: {
      ibAccount: { select: { accountNumber: true, fullName: true } },
      clientAccount: { select: { accountNumber: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows = await Promise.all(
    relationships.map(async (r) => ({
      id: r.id,
      ibAccountId: r.ibAccountId,
      ibAccountNumber: r.ibAccount.accountNumber,
      ibAccountFullName: r.ibAccount.fullName,
      clientAccountId: r.clientAccountId,
      clientAccountNumber: r.clientAccount.accountNumber,
      clientAccountFullName: r.clientAccount.fullName,
      commissionType: r.commissionType,
      commissionRate: r.commissionRate.toString(),
      pendingCommission: (await computePendingCommission(prisma, r)).toFixed(4),
      lastPayoutAt: r.lastPayoutAt ? r.lastPayoutAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }))
  );

  return NextResponse.json(rows);
}

export async function POST(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const ibAccountId = typeof body?.ibAccountId === "string" ? body.ibAccountId : "";
  const clientAccountId = typeof body?.clientAccountId === "string" ? body.clientAccountId : "";
  const commissionType = body?.commissionType === "PER_LOT" || body?.commissionType === "PERCENTAGE" ? body.commissionType : null;

  if (!ibAccountId || !clientAccountId) {
    return NextResponse.json({ error: "ibAccountId and clientAccountId are required" }, { status: 400 });
  }
  if (ibAccountId === clientAccountId) {
    return NextResponse.json({ error: "an account cannot be its own IB" }, { status: 400 });
  }
  if (!commissionType) {
    return NextResponse.json({ error: "commissionType must be PER_LOT or PERCENTAGE" }, { status: 400 });
  }

  let commissionRate: Prisma.Decimal;
  try {
    commissionRate = new Prisma.Decimal(String(body?.commissionRate ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid commissionRate" }, { status: 400 });
  }
  if (commissionRate.lte(0)) {
    return NextResponse.json({ error: "commissionRate must be positive" }, { status: 400 });
  }

  const [ibAccount, clientAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: ibAccountId } }),
    prisma.account.findUnique({ where: { id: clientAccountId } }),
  ]);
  if (!ibAccount || ibAccount.brokerId !== brokerId) {
    return NextResponse.json({ error: "IB account not found" }, { status: 404 });
  }
  if (!clientAccount || clientAccount.brokerId !== brokerId) {
    return NextResponse.json({ error: "client account not found" }, { status: 404 });
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const relationship = await tx.ibRelationship.create({
        data: { brokerId, ibAccountId, clientAccountId, commissionType, commissionRate },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "IB_RELATIONSHIP_CREATED",
          entityType: "IbRelationship",
          entityId: relationship.id,
          newValue: { ibAccountId, clientAccountId, commissionType, commissionRate: commissionRate.toString() },
        },
      });
      return relationship;
    });

    return NextResponse.json(
      {
        id: created.id,
        ibAccountId: created.ibAccountId,
        clientAccountId: created.clientAccountId,
        commissionType: created.commissionType,
        commissionRate: created.commissionRate.toString(),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "this client is already linked to an IB" }, { status: 409 });
    }
    throw error;
  }
}
