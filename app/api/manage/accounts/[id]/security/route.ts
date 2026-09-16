import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Login history for the client detail: the account's last IP + time (header) and
// the recent LoginEvent list (panel 6 SES: IP · device · time). These are login
// *events* (durable, per-login) -- not the live Redis session store, so this is
// history only, no active-session revoke. LoginEvent is written on every
// successful account login (lib/account-auth.ts).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const logins = await prisma.loginEvent.findMany({
    where: { accountId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { ipAddress: true, userAgent: true, createdAt: true },
  });
  const last = logins[0];

  return NextResponse.json({
    lastIp: last?.ipAddress ?? null,
    lastLoginAt: last ? last.createdAt.toISOString() : null,
    logins: logins.map((l) => ({ ip: l.ipAddress, userAgent: l.userAgent ?? "", at: l.createdAt.toISOString() })),
  });
}
