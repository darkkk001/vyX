import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { canReadAsManagerOrSupport } from "@/lib/permissions";

// GET /api/manage/clients: the backoffice "Registrations" view (owner 2026-11-03). A portal sign-up is a Client row
// (the portal login); a trading account is a separate, later step. The Clients screen lists trading accounts only,
// so a sign-up that never opened an account was invisible to staff. This lists exactly those: the broker's Client
// rows with NO trading account, newest first, with what staff need to act (verified or not; Resend verification is
// POST /api/manage/clients/[id]/resend-verification). Read by MANAGER, BROKER_ADMIN and SUPPORT, own broker only.
const REGISTRATIONS_LIMIT = 500;   // route files may only export handlers

export async function GET() {
  const session = await getAdminSession();
  if (!canReadAsManagerOrSupport(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const where = { brokerId, accounts: { none: {} } };
  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: REGISTRATIONS_LIMIT,
      select: { id: true, email: true, fullName: true, status: true, emailVerifiedAt: true, createdAt: true, country: true, phone: true },
    }),
    prisma.client.count({ where }),
  ]);
  return NextResponse.json({
    total,
    shown: rows.length,
    registrations: rows.map((c) => ({
      id: c.id,
      email: c.email,
      fullName: c.fullName,
      status: c.status,
      verified: c.emailVerifiedAt !== null,
      verifiedAt: c.emailVerifiedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      country: c.country,
      phone: c.phone,
    })),
  });
}
