import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Sets a broker's staff two-step sign-in policy (Broker.requireAdmin2fa): Required (true) or Optional (false).
// SUPER_ADMIN only -- no broker-side (manage) route writes this flag. Raising to Required needs no extra input; its
// staff without 2FA are confined to enrolment at their next request (lib/auth.ts getAdminSession). Lowering to Optional
// must say so explicitly (confirmOptional: true): the staff of that broker may then sign in without it.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.required !== "boolean") {
    return NextResponse.json({ error: "required must be true or false" }, { status: 400 });
  }
  const required: boolean = body.required;
  if (!required && body.confirmOptional !== true) {
    return NextResponse.json({ error: "confirm that staff will be able to sign in without two-step sign-in", code: "CONFIRM_REQUIRED" }, { status: 400 });
  }
  const existing = await prisma.broker.findUnique({ where: { id }, select: { id: true, requireAdmin2fa: true } });
  if (!existing) return NextResponse.json({ error: "broker not found" }, { status: 404 });

  if (existing.requireAdmin2fa !== required) {
    await prisma.$transaction([
      prisma.broker.update({ where: { id }, data: { requireAdmin2fa: required } }),
      prisma.auditLog.create({
        data: {
          brokerId: id,
          actorAdminId: session!.adminId,
          action: "BROKER_STAFF_2FA_POLICY_CHANGED",
          entityType: "Broker",
          entityId: id,
          oldValue: { requireAdmin2fa: existing.requireAdmin2fa },
          newValue: { requireAdmin2fa: required },
        },
      }),
    ]);
  }
  return NextResponse.json({ ok: true, staffTwoFactorRequired: required });
}
