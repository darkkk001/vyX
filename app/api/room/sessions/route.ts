import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { roomApiSession } from "@/lib/room/context";
import { revokeClientSessionById, revokeClientSession, revokeAllClientSessions, CLIENT_SESSION_COOKIE_NAME, clientSessionCookieOptions } from "@/lib/client-auth";

// DELETE ?id=<sessionId>: end one of the client's own sessions. ?id=current (or this browser's id) signs out here;
// ?id=others ends every session but this one.
export async function DELETE(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (id === "current" || id === session.sessionId) {
    const token = (await cookies()).get(CLIENT_SESSION_COOKIE_NAME)?.value;
    if (token) await revokeClientSession(token);
    const res = NextResponse.json({ status: "signed-out" });
    const { domain, path } = await clientSessionCookieOptions(false); // same scope as the cookie was set with
    res.cookies.delete({ name: CLIENT_SESSION_COOKIE_NAME, domain, path });
    return res;
  }
  if (id === "others") {
    const ended = await revokeAllClientSessions(session.clientId, session.sessionId);
    return NextResponse.json({ status: "ended", ended });
  }
  const ok = await revokeClientSessionById(session.clientId, id);
  if (!ok) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  return NextResponse.json({ status: "ended" });
}
