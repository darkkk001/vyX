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

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const existing = await prisma.group.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const leverage = Number.isFinite(Number(body?.leverage)) ? Math.trunc(Number(body.leverage)) : NaN;
  if (!Number.isFinite(leverage) || leverage <= 0) {
    return NextResponse.json({ error: "leverage must be a positive integer" }, { status: 400 });
  }
  let marginCallLevel: Prisma.Decimal;
  let stopOutLevel: Prisma.Decimal;
  try {
    marginCallLevel = new Prisma.Decimal(String(body?.marginCallLevel ?? ""));
    stopOutLevel = new Prisma.Decimal(String(body?.stopOutLevel ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid marginCallLevel/stopOutLevel" }, { status: 400 });
  }
  if (marginCallLevel.lte(0) || stopOutLevel.lte(0) || stopOutLevel.gte(marginCallLevel)) {
    return NextResponse.json(
      { error: "stopOutLevel must be positive and below marginCallLevel" },
      { status: 400 }
    );
  }
  const isDefault = body?.isDefault === true;

  let maxLotSize: Prisma.Decimal | null = null;
  if (body?.maxLotSize != null && body.maxLotSize !== "") {
    try {
      maxLotSize = new Prisma.Decimal(String(body.maxLotSize));
    } catch {
      return NextResponse.json({ error: "invalid maxLotSize" }, { status: 400 });
    }
    if (maxLotSize.lte(0)) {
      return NextResponse.json({ error: "maxLotSize must be positive when set" }, { status: 400 });
    }
  }
  const tradingRestriction = ["BOTH", "BUY_ONLY", "SELL_ONLY"].includes(body?.tradingRestriction) ? body.tradingRestriction : "BOTH";
  const swapFree = body?.swapFree === true;
  const forceDealingMode = body?.forceDealingMode === true;

  try {
    const group = await prisma.$transaction(async (tx) => {
      if (isDefault && !existing.isDefault) {
        await tx.group.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const updated = await tx.group.update({
        where: { id },
        data: { name, leverage, marginCallLevel, stopOutLevel, isDefault, maxLotSize, tradingRestriction, swapFree, forceDealingMode },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "GROUP_CONFIG_UPDATED",
          entityType: "Group",
          entityId: id,
          oldValue: {
            name: existing.name,
            leverage: existing.leverage,
            marginCallLevel: existing.marginCallLevel.toString(),
            stopOutLevel: existing.stopOutLevel.toString(),
            isDefault: existing.isDefault,
            maxLotSize: existing.maxLotSize?.toString() ?? null,
            tradingRestriction: existing.tradingRestriction,
            swapFree: existing.swapFree,
            forceDealingMode: existing.forceDealingMode,
          },
          newValue: {
            name,
            leverage,
            marginCallLevel: marginCallLevel.toString(),
            stopOutLevel: stopOutLevel.toString(),
            isDefault,
            maxLotSize: maxLotSize?.toString() ?? null,
            tradingRestriction,
            swapFree,
            forceDealingMode,
          },
        },
      });
      return updated;
    });

    return NextResponse.json({
      id: group.id,
      name: group.name,
      leverage: group.leverage,
      marginCallLevel: group.marginCallLevel.toString(),
      stopOutLevel: group.stopOutLevel.toString(),
      isDefault: group.isDefault,
      maxLotSize: group.maxLotSize ? group.maxLotSize.toString() : null,
      tradingRestriction: group.tradingRestriction,
      swapFree: group.swapFree,
      forceDealingMode: group.forceDealingMode,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "a group with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}
