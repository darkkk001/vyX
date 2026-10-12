import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, listAdminSessions, requireAdminRole } from "@/lib/auth";

// Step 3b item 5 (owner 2026-10-07): Staff, "Devices" and "IP addresses" of one staff member. BROKER_ADMIN only, same-broker staff only.
// devices = the sessions signed in right now (Redis: device, address, signed in); signIns = the last 50 sign-ins (and the sign-ins an IP
// allowlist refused) from the durable record (AdminSignIn). The session identifiers are never sent (only what a person reads).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const target = await prisma.adminUser.findUnique({ where: { id }, select: { id: true, brokerId: true } });
  if (!target || target.brokerId !== session!.brokerId) {
    return NextResponse.json({ error: "staff member not found" }, { status: 404 });
  }
  const [sessions, rows] = await Promise.all([
    listAdminSessions(target.id, undefined),
    prisma.adminSignIn.findMany({ where: { adminId: target.id }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return NextResponse.json({
    devices: sessions.map((s) => ({ userAgent: s.userAgent ?? "", ip: s.ip ?? "", createdAt: s.createdAt })),
    signIns: rows.map((r) => ({ at: r.createdAt.toISOString(), ip: r.ip, userAgent: r.userAgent, outcome: r.outcome })),
  });
}
