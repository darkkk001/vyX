import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseSymbolPricingPatch, decimalOrNull, isEmptyPricingPatch } from "@/lib/pricing-editor-shared";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Per-AccountType, per-symbol pricing (2026-09-07 Stage 5) -- same shape
// and semantics as app/api/manage/groups/[id]/pricing/route.ts's own
// GroupSymbolConfig editor, one level more specific: backed by
// AccountTypeSymbolConfig instead. A symbol with no per-symbol row here
// falls through to this AccountType's own flat spreadMarkup/
// commissionPerLot/swapLong/swapShort (returned per-row as "typeX" so the
// UI can show "inherits: 0.05" instead of a bare "inherits") -- see
// AccountTypeSymbolConfig's own schema comment for why per-symbol
// exists alongside the flat fields. targetTotalSpreadPips has no flat
// equivalent (see that same comment) -- only this per-symbol table
// supports target mode for a type.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const accountType = await prisma.accountType.findUnique({ where: { id } });
  if (!accountType || accountType.brokerId !== brokerId) {
    return NextResponse.json({ error: "account type not found" }, { status: 404 });
  }

  const [brokerSymbols, overrides] = await Promise.all([
    prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true, category: true } } },
      orderBy: { symbol: { name: "asc" } },
    }),
    prisma.accountTypeSymbolConfig.findMany({ where: { accountTypeId: id } }),
  ]);
  const overrideBySymbolId = new Map(overrides.map((o) => [o.symbolId, o]));

  return NextResponse.json(
    brokerSymbols.map((bs) => {
      const override = overrideBySymbolId.get(bs.symbolId);
      return {
        symbolId: bs.symbol.id,
        symbolName: bs.symbol.name,
        category: bs.symbol.category,
        hasOverride: !!override,
        spreadMarkup: decimalOrNull(override?.spreadMarkup ?? null),
        targetTotalSpreadPips: decimalOrNull(override?.targetTotalSpreadPips ?? null),
        commissionPerLot: decimalOrNull(override?.commissionPerLot ?? null),
        swapLong: decimalOrNull(override?.swapLong ?? null),
        swapShort: decimalOrNull(override?.swapShort ?? null),
        // This type's own flat default -- the next resolution level down
        // for a symbol with no row here. Null means the type itself
        // hasn't set one either (inherits further, from Group/Broker --
        // not resolved here, see this route's own doc comment).
        // Unified "default" field naming (2026-09-07 Stage 5) -- see
        // components/manage/SymbolPricingEditor.tsx. Null here means the
        // type itself hasn't set that field either (inherits further,
        // not resolved by this route).
        defaultSpreadMarkup: decimalOrNull(accountType.spreadMarkup),
        defaultCommissionPerLot: decimalOrNull(accountType.commissionPerLot),
        defaultSwapLong: decimalOrNull(accountType.swapLong),
        defaultSwapShort: decimalOrNull(accountType.swapShort),
      };
    })
  );
}

// Upserts (or, with `reset: true`, deletes) one symbol's override for
// this AccountType -- identical shape to the Group pricing route's own
// PATCH, see its comments for the blank-means-null and mutual-exclusion
// rules (both shared via lib/pricing-editor-shared.ts).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const { id } = await params;

  const accountType = await prisma.accountType.findUnique({ where: { id } });
  if (!accountType || accountType.brokerId !== brokerId) {
    return NextResponse.json({ error: "account type not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  if (!symbolId) {
    return NextResponse.json({ error: "symbolId is required" }, { status: 400 });
  }
  const brokerSymbol = await prisma.brokerSymbol.findFirst({ where: { brokerId, symbolId, enabled: true } });
  if (!brokerSymbol) {
    return NextResponse.json({ error: "symbol not enabled for this broker" }, { status: 400 });
  }

  const parsed = parseSymbolPricingPatch(body);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }

  if (body?.reset === true || isEmptyPricingPatch(parsed)) {
    await prisma.$transaction(async (tx) => {
      await tx.accountTypeSymbolConfig.deleteMany({ where: { accountTypeId: id, symbolId } });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ACCOUNT_TYPE_SYMBOL_PRICING_RESET",
          entityType: "AccountType",
          entityId: id,
          newValue: { symbolId },
        },
      });
    });
    return NextResponse.json({
      symbolId,
      hasOverride: false,
      spreadMarkup: null,
      targetTotalSpreadPips: null,
      commissionPerLot: null,
      swapLong: null,
      swapShort: null,
    });
  }

  const existing = await prisma.accountTypeSymbolConfig.findUnique({ where: { accountTypeId_symbolId: { accountTypeId: id, symbolId } } });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.accountTypeSymbolConfig.upsert({
      where: { accountTypeId_symbolId: { accountTypeId: id, symbolId } },
      create: { accountTypeId: id, symbolId, ...parsed },
      update: parsed,
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED",
        entityType: "AccountType",
        entityId: id,
        oldValue: existing
          ? {
              spreadMarkup: decimalOrNull(existing.spreadMarkup),
              targetTotalSpreadPips: decimalOrNull(existing.targetTotalSpreadPips),
              commissionPerLot: decimalOrNull(existing.commissionPerLot),
              swapLong: decimalOrNull(existing.swapLong),
              swapShort: decimalOrNull(existing.swapShort),
            }
          : { usingTypeDefault: true },
        newValue: {
          symbolId,
          spreadMarkup: decimalOrNull(parsed.spreadMarkup),
          targetTotalSpreadPips: decimalOrNull(parsed.targetTotalSpreadPips),
          commissionPerLot: decimalOrNull(parsed.commissionPerLot),
          swapLong: decimalOrNull(parsed.swapLong),
          swapShort: decimalOrNull(parsed.swapShort),
        },
      },
    });
    return row;
  });

  return NextResponse.json({
    symbolId,
    hasOverride: true,
    spreadMarkup: decimalOrNull(updated.spreadMarkup),
    targetTotalSpreadPips: decimalOrNull(updated.targetTotalSpreadPips),
    commissionPerLot: decimalOrNull(updated.commissionPerLot),
    swapLong: decimalOrNull(updated.swapLong),
    swapShort: decimalOrNull(updated.swapShort),
  });
}
