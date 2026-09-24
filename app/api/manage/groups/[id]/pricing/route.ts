import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publishAccountsUpdatedAfterResponse } from "@/lib/account-events";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseSymbolPricingPatch, decimalOrNull, isEmptyPricingPatch } from "@/lib/pricing-editor-shared";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Per-group pricing: every enabled BrokerSymbol for this broker, merged
// with this group's own GroupSymbolConfig override (if any) -- same
// "missing config = broker-wide default" merge SymbolConfigTable itself
// already does against Symbol. hasOverride tells the UI whether a row's
// values come from this group's own config or are just showing the
// broker-wide fallback, so a broker can tell at a glance which symbols
// they've actually customized for this group/tier. See lib/pricing-
// engine.ts's resolveFillPricing for where these values are actually
// applied at fill time (once Broker.pricingEngineEnabled is on; the old
// group-only resolveSymbolPricing otherwise).
//
// 2026-09-07 Stage 5: each pricing field is now returned as its OWN
// value (null if this row doesn't set it) rather than pre-merged with
// the broker default -- the UI shows the broker default as a separate
// muted hint per field, so a broker can tell "this specific field is
// inherited" even when other fields on the same row ARE overridden
// (the whole point of the per-field nullable migration). Also returns
// targetTotalSpreadPips alongside spreadMarkup -- the two are mutually
// exclusive per row (see lib/pricing-editor-shared.ts).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const [brokerSymbols, overrides] = await Promise.all([
    prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true, category: true } } },
      orderBy: { symbol: { name: "asc" } },
    }),
    prisma.groupSymbolConfig.findMany({ where: { groupId: id } }),
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
        // Unified "default" field naming (2026-09-07 Stage 5) shared
        // across all three pricing editors (Group/AccountType/Account),
        // even though what each one's "default" actually IS differs one
        // level per editor -- see components/manage/SymbolPricingEditor.tsx.
        defaultSpreadMarkup: bs.spreadMarkup.toString(),
        defaultCommissionPerLot: bs.commissionPerLot.toString(),
        defaultSwapLong: bs.swapLong.toString(),
        defaultSwapShort: bs.swapShort.toString(),
      };
    })
  );
}

// Upserts (or, with `reset: true`, deletes) one symbol's override for
// this group -- same per-row upsert shape as
// app/api/manage/symbols/route.ts's own PATCH, just scoped to one group
// instead of the whole broker. 2026-09-07 Stage 5: a field left
// blank/omitted now saves as null (inherit -- see lib/pricing-editor-
// shared.ts's own comment for why this changed from the pre-Stage-5
// "blank means 0" convention), and spreadMarkup/targetTotalSpreadPips
// are mutually exclusive per row.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  // reset: true removes this group's override entirely, falling back to
  // the broker-wide BrokerSymbol value -- the "un-customize" action the
  // Manager UI's own Reset button uses. A PATCH that clears every field
  // to blank (isEmptyPricingPatch) is treated the same way rather than
  // upserting a pointless all-null row -- same "skip the no-op write"
  // convention lib/group-pricing.ts's chargeCommission already uses.
  if (body?.reset === true || isEmptyPricingPatch(parsed)) {
    await prisma.$transaction(async (tx) => {
      await tx.groupSymbolConfig.deleteMany({ where: { groupId: id, symbolId } });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "GROUP_SYMBOL_PRICING_RESET",
          entityType: "Group",
          entityId: id,
          newValue: { symbolId },
        },
      });
    });
    publishAccountsUpdatedAfterResponse(brokerId, { groupId: id }, "group_pricing");
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

  const existing = await prisma.groupSymbolConfig.findUnique({ where: { groupId_symbolId: { groupId: id, symbolId } } });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.groupSymbolConfig.upsert({
      where: { groupId_symbolId: { groupId: id, symbolId } },
      create: { groupId: id, symbolId, ...parsed },
      update: parsed,
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "GROUP_SYMBOL_PRICING_UPDATED",
        entityType: "Group",
        entityId: id,
        oldValue: existing
          ? {
              spreadMarkup: decimalOrNull(existing.spreadMarkup),
              targetTotalSpreadPips: decimalOrNull(existing.targetTotalSpreadPips),
              commissionPerLot: decimalOrNull(existing.commissionPerLot),
              swapLong: decimalOrNull(existing.swapLong),
              swapShort: decimalOrNull(existing.swapShort),
            }
          : { usingBrokerDefault: true },
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

  publishAccountsUpdatedAfterResponse(brokerId, { groupId: id }, "group_pricing");
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
