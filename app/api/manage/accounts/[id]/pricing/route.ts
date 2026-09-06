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

// Per-account, per-symbol pricing override (2026-09-07 Stage 5) -- the
// most specific level in the resolution chain (lib/pricing-engine.ts),
// backed by AccountSymbolConfig. Same shape/semantics as the Group and
// AccountType pricing editors, one level more specific again: a symbol
// with no override here falls through to whatever this account's
// AccountType resolves to (its own per-symbol AccountTypeSymbolConfig
// row, else its flat default) -- returned per-row as "inheritedX" so the
// UI can show a real number, not just "inherits". Null there means the
// type itself doesn't set that field either (inherits further, from
// Group/Broker -- not resolved here, same one-hop-down convention as the
// AccountType editor).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const [brokerSymbols, overrides, accountType, typeSymbolConfigs] = await Promise.all([
    prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true, category: true } } },
      orderBy: { symbol: { name: "asc" } },
    }),
    prisma.accountSymbolConfig.findMany({ where: { accountId: id } }),
    account.accountTypeId ? prisma.accountType.findUnique({ where: { id: account.accountTypeId } }) : Promise.resolve(null),
    account.accountTypeId
      ? prisma.accountTypeSymbolConfig.findMany({ where: { accountTypeId: account.accountTypeId } })
      : Promise.resolve([]),
  ]);
  const overrideBySymbolId = new Map(overrides.map((o) => [o.symbolId, o]));
  const typeSymbolConfigBySymbolId = new Map(typeSymbolConfigs.map((c) => [c.symbolId, c]));

  return NextResponse.json(
    brokerSymbols.map((bs) => {
      const override = overrideBySymbolId.get(bs.symbolId);
      const typeSymbolConfig = typeSymbolConfigBySymbolId.get(bs.symbolId);
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
        // One hop down: this account's own type's per-symbol row for this
        // symbol, falling back to the type's flat default -- null means
        // neither is set (inherits further, from Group/Broker).
        // Unified "default" field naming (2026-09-07 Stage 5) -- see
        // components/manage/SymbolPricingEditor.tsx.
        defaultSpreadMarkup: decimalOrNull(typeSymbolConfig?.spreadMarkup ?? accountType?.spreadMarkup ?? null),
        defaultCommissionPerLot: decimalOrNull(typeSymbolConfig?.commissionPerLot ?? accountType?.commissionPerLot ?? null),
        defaultSwapLong: decimalOrNull(typeSymbolConfig?.swapLong ?? accountType?.swapLong ?? null),
        defaultSwapShort: decimalOrNull(typeSymbolConfig?.swapShort ?? accountType?.swapShort ?? null),
      };
    })
  );
}

// Upserts (or, with `reset: true`, deletes) one symbol's override for
// this account -- identical shape to the Group/AccountType pricing
// routes' own PATCH.
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
      await tx.accountSymbolConfig.deleteMany({ where: { accountId: id, symbolId } });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ACCOUNT_SYMBOL_PRICING_RESET",
          entityType: "Account",
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

  const existing = await prisma.accountSymbolConfig.findUnique({ where: { accountId_symbolId: { accountId: id, symbolId } } });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.accountSymbolConfig.upsert({
      where: { accountId_symbolId: { accountId: id, symbolId } },
      create: { accountId: id, symbolId, ...parsed },
      update: parsed,
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "ACCOUNT_SYMBOL_PRICING_UPDATED",
        entityType: "Account",
        entityId: id,
        oldValue: existing
          ? {
              spreadMarkup: decimalOrNull(existing.spreadMarkup),
              targetTotalSpreadPips: decimalOrNull(existing.targetTotalSpreadPips),
              commissionPerLot: decimalOrNull(existing.commissionPerLot),
              swapLong: decimalOrNull(existing.swapLong),
              swapShort: decimalOrNull(existing.swapShort),
            }
          : { usingInheritedDefault: true },
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
