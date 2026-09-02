import { NextResponse } from "next/server";
import { getAdminSession, listAdminSessions } from "@/lib/auth";

// Device/session management for the admin Security panel -- same shape
// as GET /api/trade/sessions, ported to AdminUser. Deliberately not
// role-gated: this is self-service ("show/revoke MY OWN sessions"),
// available to every admin role (SUPER_ADMIN, BROKER_ADMIN, MANAGER,
// SUPPORT) equally, not a privileged operation on someone else's account.
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const sessions = await listAdminSessions(session.adminId, session.sessionId);
  return NextResponse.json(sessions);
}
