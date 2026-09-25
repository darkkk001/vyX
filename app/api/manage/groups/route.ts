import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { Prisma, GroupTier, GroupDealingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LEVERAGE_RULE, parseLeverage } from "@/lib/leverage";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { resolveGroupRouting, legacyGroupTypeFor } from "@/lib/group-routing";

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

  // MirrorRule.sourceId is a polymorphic reference (Group.id or Account.id,
  // not a real FK -- see the model's own schema comment), so "does this
  // group currently source a mirror rule" can't come back via `include`.
  // One extra query, scoped by this broker + sourceType=GROUP, gives the
  // Groups form a real signal to distinguish a plain DEALING group from
  // the "Reverse (Mirror)" UI-type label (see GroupsManager.tsx's
  // uiTypeFor) -- both persist identically as groupType=DEALING.
  const mirrorSourceGroupIds = new Set(
    (
      await prisma.mirrorRule.findMany({
        where: { brokerId: session.brokerId!, sourceType: "GROUP" },
        select: { sourceId: true },
      })
    ).map((r) => r.sourceId)
  );

  // Per-group override counts for the Groups screen's PRICING column: 0 means
  // the group inherits the symbol's broker pricing ("Source"), anything else
  // is a real override the broker set. One grouped count, not N queries.
  const overrideCounts = new Map(
    (
      await prisma.groupSymbolConfig.groupBy({
        by: ["groupId"],
        where: { groupId: { in: groups.map((g) => g.id) } },
        _count: { _all: true },
      })
    ).map((r) => [r.groupId, r._count._all])
  );

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      leverage: g.leverage,
      marginCallLevel: g.marginCallLevel.toString(),
      stopOutLevel: g.stopOutLevel.toString(),
      isDefault: g.isDefault,
      // Whether a CLIENT may be placed in this group. The backoffice
      // add-account picker filters on it so a broker admin cannot drop a
      // client into the COVERAGE hedge book or the REVERSAL source group.
      isClientSelectable: g.isClientSelectable,
      maxLotSize: g.maxLotSize ? g.maxLotSize.toString() : "",
      tradingRestriction: g.tradingRestriction,
      tradingHalted: g.tradingHaltedAt != null,
      // per-group close-only (2026-09-23): the dealing desk scopes its own emergency controls with it
      closeOnly: g.closeOnlyAt != null,
      swapFree: g.swapFree,
      forceDealingMode: g.forceDealingMode,
      category: g.category,
      modeRestriction: g.modeRestriction,
      symbolConfigCount: overrideCounts.get(g.id) ?? 0,
      // Derived, not the stored shadow column, so a 1.0.9 backoffice sees
      // the same thing a 1.0.10 one does even for a group whose category
      // was last written by the new UI.
      groupType: legacyGroupTypeFor(g),
      dealingMode: g.dealingMode,
      tier: g.tier,
      hasMirrorRule: mirrorSourceGroupIds.has(g.id),
    }))
  );
}

async function postHandler(request: NextRequest) {
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

  const leverage = parseLeverage(body?.leverage);
  if (leverage == null) {
    return NextResponse.json({ error: `leverage must be ${LEVERAGE_RULE}` }, { status: 400 });
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
  // Tri-state (2026-09-07 Stage 5) -- explicit null means "inherit from
  // the hardcoded false floor" (nothing below Group in the chain).
  const swapFree: boolean | null = body?.swapFree === null ? null : body?.swapFree === true;
  const forceDealingMode = body?.forceDealingMode === true;
  const dealingMode = GROUP_DEALING_MODES.includes(body?.dealingMode) ? (body.dealingMode as GroupDealingMode) : "INHERIT";
  const tier = GROUP_TIERS.includes(body?.tier) ? (body.tier as GroupTier) : "STANDARD";
  // Phase 2 batch 1: a group created here can be offered to clients at signup (it never could before)
  const isClientSelectable = body?.isClientSelectable === true;
  // Two axes since Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md (§0.1):
  // `category` is ROUTING (where the order goes, who holds the risk) and
  // `modeRestriction` is which account MODES may sit in this group. A body
  // carrying only the legacy `groupType` is backoffice 1.0.9 and goes
  // through the shim in lib/group-routing.ts. groupType itself is still
  // written, as this release's shadow column for rollback and for the
  // dealing-desk readers that have not moved yet.
  const routing = resolveGroupRouting(body, dealingMode);
  const { category, modeRestriction } = routing;
  const groupType = legacyGroupTypeFor(routing);

  try {
    const group = await prisma.$transaction(async (tx) => {
      // Only one default group per broker -- clear any existing one
      // first, same "last write wins" convention as a single-select radio.
      if (isDefault) {
        await tx.group.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const created = await tx.group.create({
        data: { brokerId, name, leverage, marginCallLevel, stopOutLevel, isDefault, maxLotSize, tradingRestriction, swapFree, forceDealingMode, category, modeRestriction, groupType, dealingMode, tier, isClientSelectable },
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
            category,
            modeRestriction,
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
        category: group.category,
        modeRestriction: group.modeRestriction,
        groupType: group.groupType,
        dealingMode: group.dealingMode,
        tier: group.tier,
        hasMirrorRule: false,
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

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const POST = withConfigEvent("groups", postHandler);
