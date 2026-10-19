import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { groupStepOffGrid } from "@/lib/risk";

// Group volume step ("lot multiplier"), validated the same way by group create (POST) and edit (PATCH), after
// parseGroupMinLot (lib/group-min-volume.ts) has settled the minimum. Absent from the body = keep the stored value (older
// backoffice builds never send it); null or "" = no group step (the symbol's own step applies). Refused when not
// positive, above 100, with more than 2 decimals, not a whole multiple of every tradable symbol's own step
// (GROUP_STEP_OFF_GRID), or, with a group minimum, when that minimum is not a multiple of the step (GROUP_STEP_MIN_OFF_GRID).
export type LotStepResult = { ok: true; value: Prisma.Decimal | null } | { ok: false; status: number; body: Record<string, unknown> };

export async function parseGroupLotStep(
  body: Record<string, unknown> | null,
  ctx: { brokerId: string; minLotSize: Prisma.Decimal | null; existing: { id: string; lotStep: Prisma.Decimal | null; restrictSymbols: boolean } | null },
): Promise<LotStepResult> {
  const present = !!body && "lotStep" in body;
  let value: Prisma.Decimal | null;
  if (!present) {
    value = ctx.existing?.lotStep ?? null;
    // a kept step is only re-checked when the minimum is part of this save
    if (value == null || !body || !("minLotSize" in body)) return { ok: true, value };
  } else {
    const raw = body!.lotStep;
    if (raw == null || raw === "") return { ok: true, value: null };
    try {
      value = new Prisma.Decimal(String(raw));
    } catch {
      return { ok: false, status: 400, body: { error: "The group volume step must be a number, for example 0.05." } };
    }
    if (value.lte(0)) return { ok: false, status: 400, body: { error: "The group volume step must be more than 0." } };
    if (value.gt(100)) return { ok: false, status: 400, body: { error: "The group volume step cannot be above 100." } };
    if (value.decimalPlaces() > 2) return { ok: false, status: 400, body: { error: "The group volume step can have at most 2 decimals." } };
  }
  const allowed = ctx.existing?.restrictSymbols
    ? (await prisma.groupSymbol.findMany({ where: { groupId: ctx.existing.id }, select: { symbolId: true } })).map((s) => s.symbolId)
    : null;
  const rows = await prisma.brokerSymbol.findMany({
    where: { brokerId: ctx.brokerId, enabled: true, ...(allowed ? { symbolId: { in: allowed } } : {}) },
    select: { minLot: true, lotStep: true, symbol: { select: { name: true } } },
  });
  const { stepOff, minOff } = groupStepOffGrid(value, ctx.minLotSize, rows.map((s) => ({ name: s.symbol.name, minLot: s.minLot, lotStep: s.lotStep })));
  if (stepOff.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `A volume step of ${value.toFixed(2)} is not a whole multiple of the volume step of ${stepOff.join(", ")}. Pick a step those symbols can trade exactly.`,
        code: "GROUP_STEP_OFF_GRID",
        symbols: stepOff,
      },
    };
  }
  if (minOff.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `The smallest trade for ${minOff.join(", ")} is not a multiple of the volume step ${value.toFixed(2)}. Change the group minimum or the step.`,
        code: "GROUP_STEP_MIN_OFF_GRID",
        symbols: minOff,
      },
    };
  }
  return { ok: true, value };
}
