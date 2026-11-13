import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { EngineRegistryError, engineView, parseEngineInput } from "@/lib/engine-registry";

// Multi-engine control plane (owner 2026-11-13), Super Admin only.
//   GET  -> every engine with its health (its own heartbeat: fresh / stale / never) and broker count
//   POST { id, name, region, gatewayUrl, status?, staleAfterSecs?, notes? } -> registers one (audited ENGINE_CREATED)
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const engines = await prisma.engine.findMany({ orderBy: { id: "asc" }, include: { _count: { select: { brokers: true } } } });
  const unassigned = await prisma.broker.count({ where: { engineId: null } });
  return NextResponse.json({ engines: engines.map((e) => engineView(e, e._count.brokers)), unassignedBrokers: unassigned });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const input = parseEngineInput(await request.json().catch(() => null), true);
    if (await prisma.engine.findUnique({ where: { id: input.id! }, select: { id: true } })) throw new EngineRegistryError("an engine with this id exists", 409);
    const created = await prisma.$transaction(async (tx) => {
      const e = await tx.engine.create({
        data: { id: input.id!, name: input.name!, region: input.region!, gatewayUrl: input.gatewayUrl!, status: input.status ?? "PLANNED", staleAfterSecs: input.staleAfterSecs ?? 30, notes: input.notes ?? "" },
      });
      await tx.auditLog.create({
        data: { brokerId: null, actorAdminId: session!.adminId, action: "ENGINE_CREATED", entityType: "Engine", entityId: e.id, oldValue: {}, newValue: { id: e.id, name: e.name, region: e.region, gatewayUrl: e.gatewayUrl, status: e.status } },
      });
      return e;
    });
    return NextResponse.json(engineView(created, 0), { status: 201 });
  } catch (e) {
    if (e instanceof EngineRegistryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
