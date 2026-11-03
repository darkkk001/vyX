import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { hashPassword, revokeAllClientSessions } from "@/lib/client-auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// POST {current, next}: the client's one password. It is also the trading password of every own account ("your portal
// password works on every platform", Downloads), so all of them move together; every other session of the client and
// every session of those accounts ends (a credential change), this browser stays signed in.
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-password:${session.clientId}`, 5, 300);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const current = typeof body?.current === "string" ? body.current : "";
  const next = typeof body?.next === "string" ? body.next : "";
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) return NextResponse.json({ error: "Use at least 8 characters with a letter and a number." }, { status: 400 });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(current, client.passwordHash))) return NextResponse.json({ error: "Current password is wrong." }, { status: 401 });
  if (await bcrypt.compare(next, client.passwordHash)) return NextResponse.json({ error: "Pick a password you have not used here." }, { status: 400 });

  const hash = await hashPassword(next);
  const accounts = await prisma.account.findMany({ where: { clientId: session.clientId, brokerId: session.brokerId }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.client.update({ where: { id: session.clientId }, data: { passwordHash: hash } });
    if (accounts.length) await tx.account.updateMany({ where: { id: { in: accounts.map((a) => a.id) } }, data: { passwordHash: hash } });
    await tx.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "CLIENT_PASSWORD_CHANGED", entityType: "Client", entityId: session.clientId, newValue: { accounts: accounts.length, source: "CLIENT" } } });
  });
  await revokeAllClientSessions(session.clientId, session.sessionId);
  for (const a of accounts) await revokeAllAccountSessions(a.id).catch(() => 0);
  return NextResponse.json({ status: "changed" });
}
