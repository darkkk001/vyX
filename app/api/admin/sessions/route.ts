import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole, listAdminSessions } from "@/lib/auth";

// Phase 1 trust pack §2 -- lists this admin's active sessions with
// device metadata, same shape/self-healing-against-staleness behavior as
// app/api/trade/sessions's trader twin. Every admin role can see their
// own list -- this isn't a broker-wide admin capability, just "what am I
// signed into."
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN", "MANAGER", "BROKER_ADMIN", "SUPPORT"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sessions = await listAdminSessions(session!.adminId, session!.sessionId);
  return NextResponse.json(sessions);
}
