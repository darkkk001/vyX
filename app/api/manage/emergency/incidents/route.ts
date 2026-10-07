import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { getPermissionContext } from "@/lib/permissions";
import { buildIncidents, INCIDENT_ACTIONS } from "@/lib/incident-log";

// Step 3b item 4: the trading halt incident log (EMG). Built from the audit rows every halt / close-only / sign-out-all already
// writes: no new table. Same access as the screen it belongs to: a broker admin, or a manager with Risk settings or Trading halt.
// The last 500 rows of those actions (the newest first), paired into incidents (lib/incident-log.ts).
export async function GET() {
  const session = await getAdminSession();
  const permissions = await getPermissionContext(session, "manage/emergency/incidents GET");
  if (permissions.forbidUnless("RISK_SETTINGS") && permissions.forbidUnless("EMERGENCY_CONTROLS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const rows = await prisma.auditLog.findMany({
    where: { brokerId, action: { in: [...INCIDENT_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { actorAdmin: { select: { email: true } } },
  });
  const groups = await prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true } });
  const incidents = buildIncidents(
    rows.map((r) => ({ id: r.id, action: r.action, entityId: r.entityId, createdAt: r.createdAt, actorEmail: r.actorAdmin?.email ?? null, oldValue: r.oldValue, newValue: r.newValue })),
    new Map(groups.map((g) => [g.id, g.name]))
  );
  return NextResponse.json({ rows: incidents });
}
