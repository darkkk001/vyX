import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Handles two independently-permissioned edits on the same Account row:
// - groupId (MANAGER or BROKER_ADMIN) -- risk/ops config, same category
//   the symbols screen already lets MANAGER touch.
// - leverage/status (BROKER_ADMIN only) -- per AdminRole.MANAGER's own
//   schema comment ("narrower than BROKER_ADMIN... not KYC/finance"),
//   these are finance-adjacent, not dealing-desk config.
// A request can touch either or both fields; each is checked
// independently rather than requiring BROKER_ADMIN for the whole request
// just because one finance field happened to be present.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const hasGroupChange = body != null && "groupId" in body;
  const hasFinanceChange = body != null && ("leverage" in body || "status" in body || "maxDailyLoss" in body);

  if (!hasGroupChange && !hasFinanceChange) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  if (hasFinanceChange && session.role !== "BROKER_ADMIN") {
    return NextResponse.json(
      { error: "forbidden: leverage/status/maxDailyLoss changes require BROKER_ADMIN" },
      { status: 403 }
    );
  }

  let group: { id: string; leverage: number } | null = null;
  if (hasGroupChange && body.groupId != null) {
    const found = await prisma.group.findUnique({ where: { id: body.groupId } });
    if (!found || found.brokerId !== brokerId) {
      return NextResponse.json({ error: "group not found" }, { status: 404 });
    }
    group = { id: found.id, leverage: found.leverage };
  }

  let leverage: number | undefined;
  if (hasFinanceChange && "leverage" in body) {
    leverage = Number.isFinite(Number(body.leverage)) ? Math.trunc(Number(body.leverage)) : NaN;
    if (!Number.isFinite(leverage) || leverage <= 0) {
      return NextResponse.json({ error: "leverage must be a positive integer" }, { status: 400 });
    }
  }

  let status: "ACTIVE" | "SUSPENDED" | "CLOSED" | undefined;
  if (hasFinanceChange && "status" in body) {
    if (body.status !== "ACTIVE" && body.status !== "SUSPENDED" && body.status !== "CLOSED") {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    status = body.status;
  }

  let maxDailyLoss: Prisma.Decimal | null | undefined;
  if (hasFinanceChange && "maxDailyLoss" in body) {
    if (body.maxDailyLoss === null || body.maxDailyLoss === "") {
      maxDailyLoss = null;
    } else {
      try {
        maxDailyLoss = new Prisma.Decimal(String(body.maxDailyLoss));
      } catch {
        return NextResponse.json({ error: "invalid maxDailyLoss" }, { status: 400 });
      }
      if (maxDailyLoss.lte(0)) {
        return NextResponse.json({ error: "maxDailyLoss must be positive when set" }, { status: 400 });
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const data: {
      groupId?: string | null;
      leverage?: number;
      status?: typeof status;
      maxDailyLoss?: Prisma.Decimal | null;
    } = {};
    const auditEntries: { action: string; oldValue: Prisma.InputJsonValue; newValue: Prisma.InputJsonValue }[] = [];

    if (hasGroupChange) {
      data.groupId = group?.id ?? null;
      // Assigning a group copies its leverage onto the account once, at
      // assignment time -- see Group's own schema comment. Unassigning
      // (groupId: null) doesn't reset leverage; there's nothing to reset
      // it to.
      if (group) {
        data.leverage = group.leverage;
      }
      auditEntries.push({
        action: "ACCOUNT_GROUP_CHANGED",
        oldValue: { groupId: account.groupId },
        newValue: { groupId: group?.id ?? null, appliedLeverage: group?.leverage ?? null },
      });
    }

    if (leverage !== undefined) {
      data.leverage = leverage; // an explicit leverage edit always wins over a group's copied-down value
      auditEntries.push({
        action: "LEVERAGE_CHANGE",
        oldValue: { leverage: account.leverage },
        newValue: { leverage },
      });
    }
    if (status !== undefined) {
      data.status = status;
      auditEntries.push({
        action: "ACCOUNT_STATUS_CHANGED",
        oldValue: { status: account.status },
        newValue: { status },
      });
    }
    if (maxDailyLoss !== undefined) {
      data.maxDailyLoss = maxDailyLoss;
      auditEntries.push({
        action: "ACCOUNT_MAX_DAILY_LOSS_CHANGED",
        oldValue: { maxDailyLoss: account.maxDailyLoss?.toString() ?? null },
        newValue: { maxDailyLoss: maxDailyLoss?.toString() ?? null },
      });
    }

    const result = await tx.account.update({ where: { id }, data });

    for (const entry of auditEntries) {
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: entry.action,
          entityType: "Account",
          entityId: id,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
        },
      });
    }

    return result;
  });

  return NextResponse.json({
    id: updated.id,
    leverage: updated.leverage,
    status: updated.status,
    groupId: updated.groupId,
    maxDailyLoss: updated.maxDailyLoss?.toString() ?? null,
  });
}
