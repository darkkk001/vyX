import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Per-group symbol allowlist -- only consulted (lib/risk.ts's
// checkGroupAllowedSymbol) when restrictSymbols is true. `availableSymbols`
// is every symbol this broker has enabled at all (BrokerSymbol.enabled) --
// there's no point letting an admin "allow" a symbol nobody on this
// broker can trade in the first place.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const group = await prisma.group.findUnique({ where: { id }, include: { allowedSymbols: { select: { symbolId: true } } } });
  if (!group || group.brokerId !== brokerId) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }

  const brokerSymbols = await prisma.brokerSymbol.findMany({
    where: { brokerId, enabled: true },
    include: { symbol: { select: { id: true, name: true, category: true } } },
    orderBy: { symbol: { name: "asc" } },
  });

  return NextResponse.json({
    restrictSymbols: group.restrictSymbols,
    allowedSymbolIds: group.allowedSymbols.map((s) => s.symbolId),
    availableSymbols: brokerSymbols.map((bs) => ({ id: bs.symbol.id, name: bs.symbol.name, category: bs.symbol.category })),
  });
}

// Replaces the full allowlist for this group -- same "delete then
// recreate" semantics as app/api/manage/symbols/[id]/sessions/route.ts's
// PUT, the existing precedent for a small admin-edited list with no
// per-row add/delete endpoints.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const group = await prisma.group.findUnique({ where: { id } });
  if (!group || group.brokerId !== brokerId) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const restrictSymbols = body?.restrictSymbols === true;
  const rawSymbolIds = Array.isArray(body?.symbolIds) ? body.symbolIds : null;
  if (!rawSymbolIds || rawSymbolIds.some((s: unknown) => typeof s !== "string")) {
    return NextResponse.json({ error: "symbolIds must be an array of strings" }, { status: 400 });
  }

  // Silently drop anything that isn't an actually-enabled symbol for this
  // broker, same "don't trust the client's list, only what's real"
  // principle as every other list-replace route in this app.
  const validSymbolIds =
    rawSymbolIds.length === 0
      ? []
      : (
          await prisma.brokerSymbol.findMany({
            where: { brokerId, enabled: true, symbolId: { in: rawSymbolIds } },
            select: { symbolId: true },
          })
        ).map((bs) => bs.symbolId);

  await prisma.$transaction(async (tx) => {
    await tx.group.update({ where: { id }, data: { restrictSymbols } });
    await tx.groupSymbol.deleteMany({ where: { groupId: id } });
    if (validSymbolIds.length > 0) {
      await tx.groupSymbol.createMany({ data: validSymbolIds.map((symbolId) => ({ groupId: id, symbolId })) });
    }
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "GROUP_SYMBOLS_UPDATED",
        entityType: "Group",
        entityId: id,
        oldValue: { restrictSymbols: group.restrictSymbols },
        newValue: { restrictSymbols, symbolCount: validSymbolIds.length },
      },
    });
  });

  return NextResponse.json({ restrictSymbols, allowedSymbolIds: validSymbolIds });
}
