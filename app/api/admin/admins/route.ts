import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { generateTemporaryPassword } from "@/lib/passwords";

// Only Super Admins may list/create AdminUsers across brokers -- this is
// what actually closes the gap a freshly created broker has: zero admin
// accounts and no way to give it one. Same requireSuperAdmin shape as
// the sibling app/api/admin/brokers/route.ts, not the newer
// requireAdminRole helper, to match that file family's existing pattern.
async function requireSuperAdmin() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return null;
  }
  return session;
}

export async function GET() {
  const session = await requireSuperAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admins = await prisma.adminUser.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      brokerId: true,
      broker: { select: { name: true } },
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    admins.map((a) => ({
      id: a.id,
      email: a.email,
      role: a.role,
      status: a.status,
      brokerId: a.brokerId,
      brokerName: a.broker?.name ?? null,
      lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    }))
  );
}

const CREATABLE_ROLES = new Set(["BROKER_ADMIN", "MANAGER", "SUPPORT"]);

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const brokerId = typeof body?.brokerId === "string" ? body.brokerId : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body?.role === "string" && CREATABLE_ROLES.has(body.role) ? body.role : null;

  if (!brokerId || !email || !role) {
    return NextResponse.json({ error: "brokerId, email, and role are required" }, { status: 400 });
  }

  // Generated here, not accepted from the caller -- this used to take a
  // client-supplied password, and BrokersManager.tsx's caller was sending
  // the literal string "ChangeMe123!" for every single new admin across
  // every broker. A fixed, publicly-documented default password on the
  // most privileged account type below Super Admin is a real vulnerability,
  // not a placeholder. Same one-time-reveal shape as reset-password's own
  // generateTemporaryPassword() call.
  const password = generateTemporaryPassword();

  const broker = await prisma.broker.findUnique({ where: { id: brokerId } });
  if (!broker) {
    return NextResponse.json({ error: "broker not found" }, { status: 404 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const admin = await prisma.$transaction(async (tx) => {
      const created = await tx.adminUser.create({
        data: { brokerId, email, passwordHash, role, status: "ACTIVE" },
      });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "ADMIN_USER_CREATED",
          entityType: "AdminUser",
          entityId: created.id,
          newValue: { email, role, brokerId },
        },
      });
      return created;
    });

    return NextResponse.json(
      { id: admin.id, email: admin.email, role: admin.role, brokerId: admin.brokerId, password },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "an admin with this email already exists" }, { status: 409 });
    }
    throw error;
  }
}
