import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { groupMinOffGrid } from "@/lib/risk";

// Group minimum volume (owner 2026-10-06), validated the same way by group create (POST) and edit (PATCH).
// Absent from the body = keep the stored value (backoffice builds older than the form field never send it);
// null or "" = no group minimum. Refused when not positive, above the group's max lot, or off a symbol's volume grid.
export type MinLotResult = { ok: true; value: Prisma.Decimal | null } | { ok: false; status: number; body: Record<string, unknown> };

export async function parseGroupMinLot(
  body: Record<string, unknown> | null,
  ctx: { brokerId: string; maxLotSize: Prisma.Decimal | null; existing: { id: string; minLotSize: Prisma.Decimal | null; restrictSymbols: boolean } | null },
): Promise<MinLotResult> {
  if (!body || !("minLotSize" in body)) {
    const kept = ctx.existing?.minLotSize ?? null;
    // a lowered max may not slip under the minimum that is kept
    if (kept != null && ctx.maxLotSize != null && kept.gt(ctx.maxLotSize)) {
      return { ok: false, status: 400, body: { error: `The group maximum (${ctx.maxLotSize.toString()}) cannot be below the group minimum volume (${kept.toFixed(2)}).` } };
    }
    return { ok: true, value: kept };
  }
  const raw = body.minLotSize;
  if (raw == null || raw === "") return { ok: true, value: null };
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(String(raw));
  } catch {
    return { ok: false, status: 400, body: { error: "The group minimum volume must be a number, for example 0.10." } };
  }
  if (value.lte(0)) return { ok: false, status: 400, body: { error: "The group minimum volume must be more than 0." } };
  if (value.decimalPlaces() > 2) return { ok: false, status: 400, body: { error: "The group minimum volume can have at most 2 decimals." } };
  if (ctx.maxLotSize != null && value.gt(ctx.maxLotSize)) {
    return { ok: false, status: 400, body: { error: `The group minimum volume (${value.toFixed(2)}) cannot be above the group maximum (${ctx.maxLotSize.toString()}).` } };
  }
  // the symbols this group's accounts can trade: every enabled symbol, or only the allowed list when the group restricts
  const allowed = ctx.existing?.restrictSymbols
    ? (await prisma.groupSymbol.findMany({ where: { groupId: ctx.existing.id }, select: { symbolId: true } })).map((s) => s.symbolId)
    : null;
  const symbols = await prisma.brokerSymbol.findMany({
    where: { brokerId: ctx.brokerId, enabled: true, ...(allowed ? { symbolId: { in: allowed } } : {}) },
    select: { minLot: true, lotStep: true, symbol: { select: { name: true } } },
  });
  const off = groupMinOffGrid(value, symbols.map((s) => ({ name: s.symbol.name, minLot: s.minLot, lotStep: s.lotStep })));
  if (off.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `A minimum of ${value.toFixed(2)} lots does not fit the volume steps of ${off.join(", ")}. Pick a minimum those symbols can trade exactly.`,
        code: "MIN_VOLUME_STEP",
        symbols: off,
      },
    };
  }
  return { ok: true, value };
}
