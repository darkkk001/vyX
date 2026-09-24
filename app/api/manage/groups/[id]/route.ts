import { NextRequest, NextResponse } from "next/server";
import { Prisma, GroupTier, GroupDealingMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishAccountsUpdatedAfterResponse } from "@/lib/account-events";
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
  // Tri-state (2026-09-07 Stage 5, now that Group.swapFree is nullable and
  // actually read at fill time -- lib/pricing-engine.ts): explicit null
  // means "inherit from the hardcoded false floor" (there's nothing below
  // Group in the swap-free chain), true/false are explicit overrides. This
  // form always resends the full object, so there's no "field absent ->
  // keep existing" case to handle here, unlike a true partial PATCH.
  const swapFree: boolean | null = body?.swapFree === null ? null : body?.swapFree === true;
  const forceDealingMode = body?.forceDealingMode === true;
  const dealingMode = GROUP_DEALING_MODES.includes(body?.dealingMode) ? (body.dealingMode as GroupDealingMode) : "INHERIT";
  const tier = GROUP_TIERS.includes(body?.tier) ? (body.tier as GroupTier) : "STANDARD";
  // Two axes since Stage 1 of docs/ACCOUNT-STRUCTURE-MIGRATION.md (§0.1):
  // `category` is ROUTING (where the order goes, who holds the risk) and
  // `modeRestriction` is which account MODES may sit in this group. A body
  // carrying only the legacy `groupType` is backoffice 1.0.9 and goes
  // through the shim in lib/group-routing.ts. groupType itself is still
  // written, as this release's shadow column for rollback and for the
  // dealing-desk readers that have not moved yet.
  // `existing` is passed so a 1.0.9 client resending `groupType: "DEALING"`
  // cannot silently downgrade a REVERSAL or COVERAGE group it has no way
  // to express.
  const routing = resolveGroupRouting(body, dealingMode, {
    category: existing.category,
    modeRestriction: existing.modeRestriction,
  });
  const { category, modeRestriction } = routing;
  const groupType = legacyGroupTypeFor(routing);

  try {
    const group = await prisma.$transaction(async (tx) => {
      if (isDefault && !existing.isDefault) {
        await tx.group.updateMany({ where: { brokerId, isDefault: true }, data: { isDefault: false } });
      }
      const updated = await tx.group.update({
        where: { id },
        data: { name, leverage, marginCallLevel, stopOutLevel, isDefault, maxLotSize, tradingRestriction, swapFree, forceDealingMode, category, modeRestriction, groupType, dealingMode, tier },
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
            category: existing.category,
            modeRestriction: existing.modeRestriction,
            groupType: existing.groupType,
            dealingMode: existing.dealingMode,
            tier: existing.tier,
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
            category,
            modeRestriction,
            groupType,
            dealingMode,
            tier,
          },
        },
      });
      return updated;
    });
    publishAccountsUpdatedAfterResponse(brokerId, { groupId: id }, "group");

    // Same polymorphic-reference lookup as GET's own -- see that route's
    // comment. Recomputed here (not just echoed from the request body) so
    // the row the form gets back after Save reflects reality even though
    // this route never writes MirrorRule itself.
    const hasMirrorRule =
      (await prisma.mirrorRule.count({ where: { brokerId, sourceType: "GROUP", sourceId: group.id } })) > 0;

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
      category: group.category,
      modeRestriction: group.modeRestriction,
      groupType: legacyGroupTypeFor(group),
      dealingMode: group.dealingMode,
      tier: group.tier,
      hasMirrorRule,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "a group with this name already exists" }, { status: 409 });
    }
    throw error;
  }
}

// Destructive -- BROKER_ADMIN only, same escalation above PATCH/POST's
// MANAGER-or-BROKER_ADMIN gate that app/api/manage/lp-routing/[id]/
// route.ts's own DELETE already established as this app's convention for
// a hard delete. Two hard blocks, in order: the broker's default group
// (every account without an explicit group falls back to it -- see
// Account.groupId's own schema comment -- so deleting it would silently
// break that fallback for future account creation) can never be deleted
// regardless of account count, and a group with ANY accounts still
// assigned is blocked outright rather than cascading -- there is no
// "reassign on delete" flow, and Account.groupId has no onDelete
// behavior of its own to fall back on, so a bypassed check here would
// leave Account rows with a group foreign key that no longer resolves.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;

  const existing = await prisma.group.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }

  if (existing.isDefault) {
    return NextResponse.json(
      { error: "the default group cannot be deleted, make another group the default first" },
      { status: 400 }
    );
  }

  const accountCount = await prisma.account.count({ where: { groupId: id } });
  if (accountCount > 0) {
    return NextResponse.json(
      {
        error: `Cannot delete: ${accountCount} account${accountCount === 1 ? " is" : "s are"} still in this group. Move its accounts first.`,
        code: "GROUP_IN_USE",
      },
      { status: 409 }
    );
  }

  // The accountCount check above is the normal path, but it is a
  // check-then-act: an account can be assigned to this group between the
  // count and the delete. Since Stage 3b made Account.groupId NOT NULL, the
  // FK's ON DELETE SET NULL can no longer fire, so that race surfaces as a
  // constraint violation rather than a silent ungrouping. Catch it and answer
  // with the same 409 the counted path gives, instead of a 500.
  try {
  await prisma.$transaction(async (tx) => {
    // GroupSymbol/GroupSymbolConfig both cascade on Group (see their own
    // onDelete: Cascade), so this alone is enough -- no orphaned rows.
    await tx.group.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session!.adminId,
        action: "GROUP_DELETED",
        entityType: "Group",
        entityId: id,
        oldValue: {
          name: existing.name,
          leverage: existing.leverage,
          category: existing.category,
          modeRestriction: existing.modeRestriction,
          dealingMode: existing.dealingMode,
          groupType: existing.groupType,
        },
      },
    });
  });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2003" || error.code === "P2014")) {
      return NextResponse.json(
        { error: "Cannot delete: an account was assigned to this group while it was being deleted. Reassign it first.", code: "GROUP_IN_USE" },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json({ ok: true });
}
