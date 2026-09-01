import { NextRequest, NextResponse } from "next/server";
import { Prisma, GroupType, GroupTier, GroupDealingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const GROUP_TYPES: GroupType[] = ["LP", "DEALING", "DEMO"];
const GROUP_TIERS: GroupTier[] = ["STANDARD", "PRO", "ECN", "ZERO"];
const GROUP_DEALING_MODES: GroupDealingMode[] = ["INHERIT", "AUTO", "MANUAL"];

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const groups = await prisma.group.findMany({
    where: { brokerId: session.brokerId! },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      leverage: g.leverage,
      marginCallLevel: g.marginCallLevel.toString(),
      stopOutLevel: g.stopOutLevel.toString(),
      isDefault: g.isDefault,
      maxLotSize: g.maxLotSize ? g.maxLotSize.toString() : "",
      tradingRestriction: g.tradingRestriction,
      swapFree: g.swapFree,
      forceDealingMode: g.forceDealingMode,
      groupType: g.groupType,
      dealingMode: g.dealingMode,
      tier: g.tier,
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

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
    marginCallLevel = new Prisma.Decimal(String(body?.marginCallLevel ?? "100"));
    stopOutLevel = new Prisma.Decimal(String(body?.stopOutLevel ?? "50"));
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
  const groupType = GROUP_TYPES.includes(body?.groupType) ? (body.groupType as GroupType) : "DEALING";
  const dealingMode = GROUP_DEALING_MODES.includes(body?.dealingMode) ? (body.dealingMode as GroupDealingMode) : "INHERIT";
  const tier = GROUP_TIERS.includes(body?.tier) ? (body.tier as GroupTier) : "STANDARD";

  try {
    const group = await prisma.$transaction(async (tx) => {
      // Only one default group per broker -- clear any existing one
      // first, same "last write wins" convention as a single-select radio.
      if (isDefault) {
        await tx.group.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const created = await tx.group.create({
        data: { brokerId, name, leverage, marginCallLevel, stopOutLevel, isDefault, maxLotSize, tradingRestriction, swapFree, forceDealingMode, groupType, dealingMode, tier },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "GROUP_CREATED",
          entityType: "Group",
          entityId: created.id,
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
            groupType,
            dealingMode,
            tier,
          },
        },
      });
      return created;
    });

    return NextResponse.json(
      {
        id: group.id,
        name: group.name,
        leverage: group.leverage,
        marginCallLevel: group.marginCallLevel.toString(),
        stopOutLevel: group.stopOutLevel.toString(),
        isDefault: group.isDefault,
        maxLotSize: group.maxLotSize ? group.maxLotSize.toString() : "",
        tradingRestriction: group.tradingRestriction,
        swapFree: group.swapFree,
        forceDealingMode: group.forceDealingMode,
        groupType: group.groupType,
        dealingMode: group.dealingMode,
        tier: group.tier,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "a group with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}
