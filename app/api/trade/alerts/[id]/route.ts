import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { publishAlertConfig } from "@/lib/nats";

// Cancels (status -> CANCELLED, never hard-deleted -- same "keep the
// row, change its status" convention every other entity in this schema
// uses) an alert and hot-reloads engine/server's in-memory AlertCache so
// it stops being checked against the very next tick instead of only
// after the engine's next restart.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const alert = await prisma.priceAlert.findUnique({ where: { id } });
  if (!alert || alert.accountId !== session.accountId) {
    return NextResponse.json({ error: "alert not found" }, { status: 404 });
  }
  if (alert.status !== "ACTIVE") {
    return NextResponse.json({ error: `cannot cancel an alert in status ${alert.status}` }, { status: 409 });
  }

  await prisma.priceAlert.update({ where: { id }, data: { status: "CANCELLED" } });
  await publishAlertConfig({ action: "cancel", id, broker_id: alert.brokerId });

  return NextResponse.json({ ok: true });
}
