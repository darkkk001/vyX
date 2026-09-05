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

// Per-group pricing: every enabled BrokerSymbol for this broker, merged
// with this group's own GroupSymbolConfig override (if any) -- same
// "missing config = broker-wide default" merge SymbolConfigTable itself
// already does against Symbol. hasOverride tells the UI whether a row's
// values come from this group's own config or are just showing the
// broker-wide fallback, so a broker can tell at a glance which symbols
// they've actually customized for this group/tier. See
// lib/group-pricing.ts's resolveSymbolPricing for where these values are
// actually applied at fill time.
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
        spreadMarkup: (override ? override.spreadMarkup : bs.spreadMarkup).toString(),
        commissionPerLot: (override ? override.commissionPerLot : bs.commissionPerLot).toString(),
        swapLong: (override ? override.swapLong : bs.swapLong).toString(),
        swapShort: (override ? override.swapShort : bs.swapShort).toString(),
        brokerSpreadMarkup: bs.spreadMarkup.toString(),
        brokerCommissionPerLot: bs.commissionPerLot.toString(),
        brokerSwapLong: bs.swapLong.toString(),
        brokerSwapShort: bs.swapShort.toString(),
      };
    })
  );
}

function parseDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const d = new Prisma.Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

// 2026-09-05 real bug fixed here: a broker leaving spreadMarkup/
// commissionPerLot/swapLong/swapShort blank (choosing "no markup/no
// commission/no swap") got a bare "must be a valid number" error instead
// -- forcing them to type a literal "0" in every pricing field. Blank
// means zero for all four of these; only genuinely non-numeric input
// (e.g. stray text) should still reject.
function parseDecimalOrZero(value: unknown): Prisma.Decimal | null {
  if (value == null || value === "") return new Prisma.Decimal(0);
  return parseDecimal(value);
}

// Upserts (or, with `reset: true`, deletes) one symbol's override for
// this group -- same per-row upsert shape as
// app/api/manage/symbols/route.ts's own PATCH, just scoped to one group
// instead of the whole broker.
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

  // reset: true removes this group's override entirely, falling back to
  // the broker-wide BrokerSymbol value -- the "un-customize" action the
  // Manager UI's own Reset button uses.
  if (body?.reset === true) {
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
    return NextResponse.json({
      symbolId,
      hasOverride: false,
      spreadMarkup: brokerSymbol.spreadMarkup.toString(),
      commissionPerLot: brokerSymbol.commissionPerLot.toString(),
      swapLong: brokerSymbol.swapLong.toString(),
      swapShort: brokerSymbol.swapShort.toString(),
    });
  }

  const spreadMarkup = parseDecimalOrZero(body?.spreadMarkup);
  const commissionPerLot = parseDecimalOrZero(body?.commissionPerLot);
  const swapLong = parseDecimalOrZero(body?.swapLong);
  const swapShort = parseDecimalOrZero(body?.swapShort);
  if (!spreadMarkup || !commissionPerLot || !swapLong || !swapShort) {
    return NextResponse.json({ error: "spreadMarkup, commissionPerLot, swapLong, and swapShort must all be valid numbers (leave blank for 0)" }, { status: 400 });
  }
  if (spreadMarkup.lt(0) || commissionPerLot.lt(0)) {
    return NextResponse.json({ error: "spreadMarkup and commissionPerLot must not be negative" }, { status: 400 });
  }

  const existing = await prisma.groupSymbolConfig.findUnique({ where: { groupId_symbolId: { groupId: id, symbolId } } });
  const data = { spreadMarkup, commissionPerLot, swapLong, swapShort };

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.groupSymbolConfig.upsert({
      where: { groupId_symbolId: { groupId: id, symbolId } },
      create: { groupId: id, symbolId, ...data },
      update: data,
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
              spreadMarkup: existing.spreadMarkup.toString(),
              commissionPerLot: existing.commissionPerLot.toString(),
              swapLong: existing.swapLong.toString(),
              swapShort: existing.swapShort.toString(),
            }
          : { usingBrokerDefault: true },
        newValue: { symbolId, spreadMarkup: spreadMarkup.toString(), commissionPerLot: commissionPerLot.toString(), swapLong: swapLong.toString(), swapShort: swapShort.toString() },
      },
    });
    return row;
  });

  return NextResponse.json({
    symbolId,
    hasOverride: true,
    spreadMarkup: updated.spreadMarkup.toString(),
    commissionPerLot: updated.commissionPerLot.toString(),
    swapLong: updated.swapLong.toString(),
    swapShort: updated.swapShort.toString(),
  });
}
