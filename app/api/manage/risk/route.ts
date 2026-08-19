import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Broker-wide risk policy -- BROKER_ADMIN by default, same finance/ops
// carve-out as Funds/KYC/IB/Team, delegatable per field: `tradingHalted`
// via EMERGENCY_CONTROLS, everything else via RISK_SETTINGS (see
// lib/permissions.ts). See lib/risk.ts for how these fields are actually
// enforced on the live trading path.
export async function GET() {
  const session = await getAdminSession();
  const [forbidRisk, forbidEmergency] = await Promise.all([
    forbidUnlessBrokerAdminOrPermission(session, "RISK_SETTINGS"),
    forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS"),
  ]);
  if (forbidRisk && forbidEmergency) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });
  return NextResponse.json({
    tradingHalted: broker.tradingHaltedAt != null,
    tradingHaltedAt: broker.tradingHaltedAt ? broker.tradingHaltedAt.toISOString() : null,
    dealingMode: broker.dealingModeAt != null,
    dealingModeAt: broker.dealingModeAt ? broker.dealingModeAt.toISOString() : null,
    totalExposureLimit: broker.totalExposureLimit ? broker.totalExposureLimit.toString() : null,
    maxOpenPositionsPerAccount: broker.maxOpenPositionsPerAccount,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getAdminSession();
  if (!session || !session.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Per-field permission check -- a request touching a RISK_SETTINGS
  // field without that permission (even if it also legitimately touches
  // an EMERGENCY_CONTROLS field) is rejected outright rather than
  // silently applying only the allowed half.
  if ("tradingHalted" in body && (await forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const touchesRiskFields = "dealingMode" in body || "totalExposureLimit" in body || "maxOpenPositionsPerAccount" in body;
  if (touchesRiskFields && (await forbidUnlessBrokerAdminOrPermission(session, "RISK_SETTINGS"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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

  if ("dealingMode" in body) {
    if (typeof body.dealingMode !== "boolean") {
      return NextResponse.json({ error: "dealingMode must be a boolean" }, { status: 400 });
    }
    data.dealingModeAt = body.dealingMode ? new Date() : null;
    auditNewValue.dealingMode = body.dealingMode;
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
        action:
          "tradingHalted" in body ? "RISK_HALT_TOGGLED" : "dealingMode" in body ? "DEALING_MODE_TOGGLED" : "RISK_LIMITS_UPDATED",
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
    dealingMode: updated.dealingModeAt != null,
    dealingModeAt: updated.dealingModeAt ? updated.dealingModeAt.toISOString() : null,
    totalExposureLimit: updated.totalExposureLimit ? updated.totalExposureLimit.toString() : null,
    maxOpenPositionsPerAccount: updated.maxOpenPositionsPerAccount,
  });
}
