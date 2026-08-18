import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

const RESERVED_SUBDOMAINS = new Set(["admin", "www", "api"]);
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TRIAL_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

// Only Super Admins (BigFish Technologies staff, brokerId === null) may
// list or create brokers. Enforced here, server-side — never trust a
// frontend check for this.
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

  const brokers = await prisma.broker.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      subdomain: true,
      customDomain: true,
      tier: true,
      status: true,
      executionEngine: true,
      logoUrl: true,
      primaryColor: true,
      trialEndsAt: true,
      nextInvoiceAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(brokers);
}

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const subdomain =
    typeof body?.subdomain === "string" ? body.subdomain.trim().toLowerCase() : "";
  const customDomain = typeof body?.customDomain === "string" && body.customDomain.trim() ? body.customDomain.trim() : null;
  const tier = body?.tier === "WHITE_LABEL" ? "WHITE_LABEL" : "STANDARD";
  const logoUrl = typeof body?.logoUrl === "string" ? body.logoUrl : null;
  const primaryColor = typeof body?.primaryColor === "string" ? body.primaryColor : null;
  // Optional: create the first Broker Admin in the same transaction --
  // mirrors app/api/admin/admins POST's own validation, just inline here
  // so "Register broker" can be a single submit instead of two separate
  // screens. Skipped entirely if either field is left blank.
  const adminEmail = typeof body?.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
  const adminPassword = typeof body?.adminPassword === "string" ? body.adminPassword : "";

  if (!name || !subdomain) {
    return NextResponse.json({ error: "name and subdomain are required" }, { status: 400 });
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain) || RESERVED_SUBDOMAINS.has(subdomain)) {
    return NextResponse.json({ error: "invalid or reserved subdomain" }, { status: 400 });
  }
  if (adminEmail && adminPassword.length < 8) {
    return NextResponse.json({ error: "admin password must be at least 8 characters" }, { status: 400 });
  }

  try {
    const { broker, admin } = await prisma.$transaction(async (tx) => {
      // New tenants start on a trial, not immediately billable -- config-
      // only lifecycle, see lib/billing.ts and Broker.trialEndsAt's own
      // schema comment. A Super Admin can still fast-track via the
      // Tenant Detail modal's "Set active" action.
      const createdBroker = await tx.broker.create({
        data: {
          name,
          subdomain,
          customDomain,
          tier,
          logoUrl,
          primaryColor,
          status: "TRIAL",
          trialEndsAt: new Date(Date.now() + TRIAL_PERIOD_MS),
        },
      });

      await tx.auditLog.create({
        data: {
          brokerId: createdBroker.id,
          actorAdminId: session.adminId,
          action: "BROKER_CREATED",
          entityType: "Broker",
          entityId: createdBroker.id,
          oldValue: Prisma.JsonNull,
          newValue: { name: createdBroker.name, subdomain: createdBroker.subdomain, tier: createdBroker.tier, status: createdBroker.status },
        },
      });

      let createdAdmin: { id: string; email: string } | null = null;
      if (adminEmail && adminPassword) {
        const passwordHash = await bcrypt.hash(adminPassword, 10);
        createdAdmin = await tx.adminUser.create({
          data: { brokerId: createdBroker.id, email: adminEmail, passwordHash, role: "BROKER_ADMIN", status: "ACTIVE" },
          select: { id: true, email: true },
        });
        await tx.auditLog.create({
          data: {
            brokerId: createdBroker.id,
            actorAdminId: session.adminId,
            action: "ADMIN_USER_CREATED",
            entityType: "AdminUser",
            entityId: createdAdmin.id,
            newValue: { email: createdAdmin.email, role: "BROKER_ADMIN", brokerId: createdBroker.id },
          },
        });
      }

      return { broker: createdBroker, admin: createdAdmin };
    });

    return NextResponse.json({ ...broker, admin }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : "";
      return NextResponse.json(
        { error: target.includes("email") ? "an admin with this email already exists" : "subdomain already taken" },
        { status: 409 }
      );
    }
    throw error;
  }
}
