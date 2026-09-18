import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { consumePasswordResetToken, hashPassword, revokeAllClientSessions } from "@/lib/client-auth";

// Consumes the token POST /api/portal/forgot-password minted (single-use,
// 1h TTL) and sets a new password. Does NOT log the client in -- same as
// most real reset flows, forces a fresh login with the new credential
// rather than trusting possession of the reset link as an ongoing session.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "reset token is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const clientId = await consumePasswordResetToken(token);
  if (!clientId) {
    return NextResponse.json({ error: "this reset link is invalid or has expired, request a new one" }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.client.update({ where: { id: clientId }, data: { passwordHash } });
  // A reset is the takeover remediation: every existing session dies with
  // the old credential (pentest 2026-09-18 #2). Nothing to keep -- this
  // flow never logs the client in.
  await revokeAllClientSessions(clientId);

  return NextResponse.json({ ok: true });
}
