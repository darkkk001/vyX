import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession, revokeAccountSessionById } from "@/lib/account-auth";

// Revokes one *other* device's session remotely -- "log out everywhere
// but here" is just calling this for every row except the current one.
// Revoking the current session works too (equivalent to
// POST /api/trade/logout) -- no special-casing needed, since
// revokeAccountSessionById already scopes to this account only.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;

  const revoked = await revokeAccountSessionById(session.accountId, id);
  if (!revoked) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  await prisma.auditLog.create({
    data: {
      brokerId: session.brokerId,
      action: "WEBTRADER_SESSION_REVOKED",
      entityType: "Account",
      entityId: session.accountId,
      oldValue: {},
      newValue: { sessionId: id },
    },
  });

  return NextResponse.json({ ok: true });
}
