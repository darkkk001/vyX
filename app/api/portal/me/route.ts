import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";
import { resolveProfileUpdate, identityLocked, dateOnly, type KycState } from "@/lib/client-profile";

const PROFILE_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  country: true,
  dateOfBirth: true,
  emailVerifiedAt: true,
  status: true,
  createdAt: true,
  kycRecord: { select: { status: true } },
} as const;

type ProfileRow = NonNullable<Awaited<ReturnType<typeof loadProfile>>>;

function loadProfile(clientId: string) {
  return prisma.client.findUnique({ where: { id: clientId }, select: PROFILE_SELECT });
}

// the portal's Profile screen reads this shape (app/(broker)/portal/(shell)/profile/ProfileView.tsx)
function toJson(c: ProfileRow) {
  const kycStatus = (c.kycRecord?.status ?? null) as KycState;
  return {
    id: c.id,
    email: c.email,
    fullName: c.fullName,
    phone: c.phone,
    country: c.country,
    dateOfBirth: dateOnly(c.dateOfBirth),
    emailVerifiedAt: c.emailVerifiedAt,
    status: c.status,
    createdAt: c.createdAt,
    kycStatus,
    identityLocked: identityLocked(kycStatus),
  };
}

// Confirms the whole Stage 1 auth loop actually holds together end to
// end (register -> verify -> login -> session persists), same role
// app/api/trade/me plays for the trader session; the portal's Profile screen reads it too.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const client = await loadProfile(session.clientId);
  if (!client) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  return NextResponse.json(toJson(client));
}

// Profile edits (restored and reviewed 2026-09-28 from the unmerged 2026-09-18 snapshot ecb253c). The rules
// (phone always; name / country / date of birth only until KYC is submitted; email never) live in
// lib/client-profile.ts. Only whitelisted fields are read from the body: status, emailVerifiedAt, brokerId and
// passwordHash are ignored (tests/pentest/auth-privilege-and-mass-assignment.test.ts). Every applied change is one
// CLIENT_PROFILE_UPDATED audit row with the old and new values, in the same transaction as the update.
export async function PATCH(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const current = await loadProfile(session.clientId);
  if (!current) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const result = resolveProfileUpdate(body, current, (current.kycRecord?.status ?? null) as KycState);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  if (result.changes.length === 0) {
    return NextResponse.json(toJson(current));
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.client.update({ where: { id: current.id }, data: result.data, select: PROFILE_SELECT });
    await tx.auditLog.create({
      data: {
        brokerId: session.brokerId,
        actorAdminId: null,
        action: "CLIENT_PROFILE_UPDATED",
        entityType: "Client",
        entityId: current.id,
        oldValue: Object.fromEntries(result.changes.map((c) => [c.field, c.from])),
        newValue: { ...Object.fromEntries(result.changes.map((c) => [c.field, c.to])), changedBy: "client", email: current.email },
      },
    });
    return row;
  });
  return NextResponse.json(toJson(updated));
}
