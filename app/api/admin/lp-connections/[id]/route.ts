import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { connectionSnapshot, LpConnectionInputError, parseTimeoutFields } from "@/lib/lp-connection-input";
import { CONNECTION_INCLUDE, connectionView, loadConnection } from "@/lib/lp-connections";

// Super Admin: the timeout / retry values of one LP connection (ackTimeoutMs, orderTtlSecs, maxAttempts,
// reconcileTimeoutSecs; null = the bridge's own default). Nothing else is editable here. Audited
// LP_CONNECTION_TIMEOUTS_CHANGED on the connection's broker.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const fields = parseTimeoutFields(body);
    const row = await prisma.$transaction(async (tx) => {
      const before = await loadConnection(tx, id, null, true);
      if (!before) return null;
      const changed = Object.entries(fields).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v);
      if (changed.length === 0) return before;
      const after = await tx.lpConnection.update({ where: { id }, data: Object.fromEntries(changed), include: CONNECTION_INCLUDE });
      await tx.auditLog.create({
        data: {
          brokerId: before.brokerId,
          actorAdminId: session!.adminId,
          action: "LP_CONNECTION_TIMEOUTS_CHANGED",
          entityType: "LpConnection",
          entityId: id,
          oldValue: connectionSnapshot(before),
          newValue: connectionSnapshot(after),
        },
      });
      return after;
    });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(connectionView(row, { timeouts: true }));
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
