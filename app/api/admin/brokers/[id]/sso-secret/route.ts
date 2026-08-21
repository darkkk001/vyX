import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Generates (or rotates) the broker's WebTrader SSO secret -- see
// lib/sso.ts and docs/webtrader-stm-architecture-review.md §4.1. Returned
// in plaintext exactly once, in this response; Broker.ssoSecret is never
// read back out to a client anywhere else (the Brokers list only ever
// receives whether one is set, not its value -- see BrokersManager.tsx).
// SUPER_ADMIN only: this is a platform-issued credential a broker's own
// external portal uses to vouch for its traders, not something a
// broker's own staff should be able to mint or see themselves.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.broker.findUnique({ where: { id }, select: { id: true, ssoSecret: true } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  const secret = `sso_${crypto.randomBytes(24).toString("hex")}`;
  await prisma.$transaction([
    prisma.broker.update({ where: { id }, data: { ssoSecret: secret } }),
    prisma.auditLog.create({
      data: {
        brokerId: id,
        actorAdminId: session!.adminId,
        action: existing.ssoSecret ? "BROKER_SSO_SECRET_ROTATED" : "BROKER_SSO_SECRET_GENERATED",
        entityType: "Broker",
        entityId: id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ssoSecret: secret });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.broker.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.broker.update({ where: { id }, data: { ssoSecret: null } }),
    prisma.auditLog.create({
      data: {
        brokerId: id,
        actorAdminId: session!.adminId,
        action: "BROKER_SSO_SECRET_REVOKED",
        entityType: "Broker",
        entityId: id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
