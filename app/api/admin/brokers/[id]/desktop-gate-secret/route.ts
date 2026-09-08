import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Generates (or rotates) the secret manager-tauri/rebrand.js bakes into
// this broker's own build to prove it's the genuine packaged app -- see
// Broker.desktopGateSecret's own schema comment and app/api/manage/
// desktop-gate/route.ts. Direct sibling of ../sso-secret/route.ts (same
// shown-once/plaintext/SUPER_ADMIN-only conventions), a separate secret
// because it proves a different thing.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.broker.findUnique({ where: { id }, select: { id: true, desktopGateSecret: true } });
  if (!existing) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  const secret = `dgs_${crypto.randomBytes(24).toString("hex")}`;
  await prisma.$transaction([
    prisma.broker.update({ where: { id }, data: { desktopGateSecret: secret } }),
    prisma.auditLog.create({
      data: {
        brokerId: id,
        actorAdminId: session!.adminId,
        action: existing.desktopGateSecret ? "BROKER_DESKTOP_GATE_SECRET_ROTATED" : "BROKER_DESKTOP_GATE_SECRET_GENERATED",
        entityType: "Broker",
        entityId: id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ desktopGateSecret: secret });
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
    prisma.broker.update({ where: { id }, data: { desktopGateSecret: null } }),
    prisma.auditLog.create({
      data: {
        brokerId: id,
        actorAdminId: session!.adminId,
        action: "BROKER_DESKTOP_GATE_SECRET_REVOKED",
        entityType: "Broker",
        entityId: id,
        oldValue: {},
        newValue: {},
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
