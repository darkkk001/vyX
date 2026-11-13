import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assignBrokerEngine, EngineRegistryError } from "@/lib/engine-registry";

// Multi-engine control plane (owner 2026-11-13), Super Admin only: one broker's engine.
//   GET -> { engineId, history } (the append-only EngineAssignmentLog, newest first)
//   PUT { engineId: string | null, reason } -> assigns / moves / unassigns it (Broker.engineId + a history row + audit BROKER_ENGINE_ASSIGNED).
//       Dormant until the engine step: no engine reads the assignment yet.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const broker = await prisma.broker.findUnique({ where: { id }, select: { id: true, engineId: true } });
  if (!broker) return NextResponse.json({ error: "broker not found" }, { status: 404 });
  const history = await prisma.engineAssignmentLog.findMany({ where: { brokerId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  const adminIds = [...new Set(history.map((h) => h.adminId).filter((x): x is string => !!x))];
  const admins = adminIds.length ? await prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, email: true } }) : [];
  const email = new Map(admins.map((a) => [a.id, a.email]));
  return NextResponse.json({
    engineId: broker.engineId,
    history: history.map((h) => ({ id: h.id, from: h.fromEngineId, to: h.toEngineId, reason: h.reason, by: h.adminId ? (email.get(h.adminId) ?? h.adminId) : null, at: h.createdAt.toISOString() })),
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { engineId?: unknown; reason?: unknown } | null;
  if (!body || !("engineId" in body) || (body.engineId !== null && typeof body.engineId !== "string")) {
    return NextResponse.json({ error: "engineId: an engine id, or null to unassign" }, { status: 400 });
  }
  try {
    const out = await assignBrokerEngine(prisma, { brokerId: id, engineId: body.engineId as string | null, reason: typeof body.reason === "string" ? body.reason : "", adminId: session!.adminId });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof EngineRegistryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
