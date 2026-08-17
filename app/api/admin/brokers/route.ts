import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";

const RESERVED_SUBDOMAINS = new Set(["admin", "www", "api"]);
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
  const tier = body?.tier === "WHITE_LABEL" ? "WHITE_LABEL" : "STANDARD";
  const logoUrl = typeof body?.logoUrl === "string" ? body.logoUrl : null;
  const primaryColor = typeof body?.primaryColor === "string" ? body.primaryColor : null;

  if (!name || !subdomain) {
    return NextResponse.json({ error: "name and subdomain are required" }, { status: 400 });
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain) || RESERVED_SUBDOMAINS.has(subdomain)) {
    return NextResponse.json({ error: "invalid or reserved subdomain" }, { status: 400 });
  }

  try {
    const broker = await prisma.broker.create({
      data: { name, subdomain, tier, logoUrl, primaryColor },
    });

    await prisma.auditLog.create({
      data: {
        brokerId: broker.id,
        actorAdminId: session.adminId,
        action: "BROKER_CREATED",
        entityType: "Broker",
        entityId: broker.id,
        oldValue: Prisma.JsonNull,
        newValue: { name: broker.name, subdomain: broker.subdomain, tier: broker.tier },
      },
    });

    return NextResponse.json(broker, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "subdomain already taken" }, { status: 409 });
    }
    throw error;
  }
}
