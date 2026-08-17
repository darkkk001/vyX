import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Team management is finance/admin-tier, same gating as Funds/KYC/IB --
// BROKER_ADMIN only, not the broader ["MANAGER","BROKER_ADMIN"] gate
// Symbols/Positions/Groups/Accounts use.
async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admins = await prisma.adminUser.findMany({
    where: { brokerId: session.brokerId! },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true },
  });

  return NextResponse.json(
    admins.map((a) => ({
      id: a.id,
      email: a.email,
      role: a.role,
      status: a.status,
      lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    }))
  );
}

const CREATABLE_ROLES = new Set(["BROKER_ADMIN", "MANAGER", "SUPPORT"]);

export async function POST(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const role = typeof body?.role === "string" && CREATABLE_ROLES.has(body.role) ? body.role : null;

  if (!email || !role) {
    return NextResponse.json({ error: "email and role are required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
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
          newValue: { email, role },
        },
      });
      return created;
    });

    return NextResponse.json({ id: admin.id, email: admin.email, role: admin.role }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "an admin with this email already exists" }, { status: 409 });
    }
    throw error;
  }
}
