import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Broker-wide risk policy -- BROKER_ADMIN only, same finance/ops
// carve-out as Funds/KYC/IB/Team. See lib/risk.ts for how these fields
// are actually enforced on the live trading path.
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId! } });
  return NextResponse.json({
    tradingHalted: broker.tradingHaltedAt != null,
    tradingHaltedAt: broker.tradingHaltedAt ? broker.tradingHaltedAt.toISOString() : null,
    totalExposureLimit: broker.totalExposureLimit ? broker.totalExposureLimit.toString() : null,
    maxOpenPositionsPerAccount: broker.maxOpenPositionsPerAccount,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const data: Prisma.BrokerUpdateInput = {};
  const auditNewValue: Record<string, Prisma.InputJsonValue | null> = {};

  if ("tradingHalted" in body) {
    if (typeof body.tradingHalted !== "boolean") {
      return NextResponse.json({ error: "tradingHalted must be a boolean" }, { status: 400 });
    }
    data.tradingHaltedAt = body.tradingHalted ? new Date() : null;
    auditNewValue.tradingHalted = body.tradingHalted;
  }

  if ("totalExposureLimit" in body) {
    if (body.totalExposureLimit === null || body.totalExposureLimit === "") {
      data.totalExposureLimit = null;
      auditNewValue.totalExposureLimit = null;
    } else {
      let limit: Prisma.Decimal;
      try {
        limit = new Prisma.Decimal(String(body.totalExposureLimit));
      } catch {
        return NextResponse.json({ error: "invalid totalExposureLimit" }, { status: 400 });
      }
      if (limit.lte(0)) {
        return NextResponse.json({ error: "totalExposureLimit must be positive" }, { status: 400 });
      }
      data.totalExposureLimit = limit;
      auditNewValue.totalExposureLimit = limit.toString();
    }
  }

  if ("maxOpenPositionsPerAccount" in body) {
    if (body.maxOpenPositionsPerAccount === null || body.maxOpenPositionsPerAccount === "") {
      data.maxOpenPositionsPerAccount = null;
      auditNewValue.maxOpenPositionsPerAccount = null;
    } else {
      const n = Math.trunc(Number(body.maxOpenPositionsPerAccount));
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: "maxOpenPositionsPerAccount must be a positive integer" }, { status: 400 });
      }
      data.maxOpenPositionsPerAccount = n;
      auditNewValue.maxOpenPositionsPerAccount = n;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const broker = await tx.broker.update({ where: { id: brokerId }, data });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "tradingHalted" in body ? "RISK_HALT_TOGGLED" : "RISK_LIMITS_UPDATED",
        entityType: "Broker",
        entityId: brokerId,
        newValue: auditNewValue,
      },
    });
    return broker;
  });

  return NextResponse.json({
    tradingHalted: updated.tradingHaltedAt != null,
    tradingHaltedAt: updated.tradingHaltedAt ? updated.tradingHaltedAt.toISOString() : null,
    totalExposureLimit: updated.totalExposureLimit ? updated.totalExposureLimit.toString() : null,
    maxOpenPositionsPerAccount: updated.maxOpenPositionsPerAccount,
  });
}
