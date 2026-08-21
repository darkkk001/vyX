import { NextResponse } from "next/server";
import { getAccountSession, listAccountSessions } from "@/lib/account-auth";

// Device/session management (docs/webtrader-stm-architecture-review.md
// §3 item 8) -- lists this account's active sessions with device
// metadata for the Security panel. See listAccountSessions's own doc
// comment for the self-healing-against-staleness behavior.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const sessions = await listAccountSessions(session.accountId, session.sessionId);
  return NextResponse.json(sessions);
}
