import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { EngineRegistryError, engineView, parseEngineInput, servedBrokerIds } from "@/lib/engine-registry";

// Multi-engine control plane (owner 2026-11-13), Super Admin only.
//   GET   -> the engine, its roster (the brokers assigned to it), what it serves by the view (empty unless ACTIVE / DRAINING) and its recent moves
//   PATCH { name?, region?, gatewayUrl?, status?, staleAfterSecs?, notes? } -> edits it (audited ENGINE_UPDATED). RETIRED is refused while it still
//         has brokers: move them first, so retiring never leaves a broker unserved.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const engine = await prisma.engine.findUnique({ where: { id } });
  if (!engine) return NextResponse.json({ error: "engine not found" }, { status: 404 });
  const brokers = await prisma.broker.findMany({
    where: { engineId: id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, subdomain: true, status: true, riskAuthority: true, riskAuthorityDemoOnly: true, _count: { select: { accounts: true } } },
  });
  const served = await servedBrokerIds(prisma, id);
  const moves = await prisma.engineAssignmentLog.findMany({ where: { OR: [{ toEngineId: id }, { fromEngineId: id }] }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({
    engine: engineView(engine, brokers.length),
    roster: brokers.map((b) => ({ id: b.id, name: b.name, subdomain: b.subdomain, status: b.status, riskAuthority: b.riskAuthority, riskAuthorityDemoOnly: b.riskAuthorityDemoOnly, accounts: b._count.accounts, served: served.includes(b.id) })),
    moves: moves.map((m) => ({ id: m.id, brokerId: m.brokerId, from: m.fromEngineId, to: m.toEngineId, reason: m.reason, at: m.createdAt.toISOString() })),
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const input = parseEngineInput(await request.json().catch(() => null), false);
    const updated = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Engine" WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0) throw new EngineRegistryError("engine not found", 404);
      const before = await tx.engine.findUniqueOrThrow({ where: { id } });
      if (input.status === "RETIRED" && before.status !== "RETIRED") {
        const assigned = await tx.broker.count({ where: { engineId: id } });
        if (assigned > 0) throw new EngineRegistryError(`move its ${assigned} broker${assigned === 1 ? "" : "s"} to another engine first`, 409);
      }
      const after = await tx.engine.update({ where: { id }, data: input });
      await tx.auditLog.create({
        data: {
          brokerId: null, actorAdminId: session!.adminId, action: "ENGINE_UPDATED", entityType: "Engine", entityId: id,
          oldValue: { name: before.name, region: before.region, gatewayUrl: before.gatewayUrl, status: before.status, staleAfterSecs: before.staleAfterSecs, notes: before.notes },
          newValue: input,
        },
      });
      return after;
    });
    const count = await prisma.broker.count({ where: { engineId: id } });
    return NextResponse.json(engineView(updated, count));
  } catch (e) {
    if (e instanceof EngineRegistryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
