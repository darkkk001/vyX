import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// BROKER_ADMIN only, not delegatable -- same category as Team/Settings
// (structural business/contractual decisions, not day-to-day
// dealing-desk ops), not one of Phase D's delegatable permissions.
// Pre-integration record-keeping only -- see LiquidityProvider's schema
// comment. No real LP connection exists anywhere in this app.
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const providers = await prisma.liquidityProvider.findMany({
    where: { brokerId: session.brokerId! },
    include: { _count: { select: { routingRules: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    providers.map((p) => ({
      id: p.id,
      name: p.name,
      contactName: p.contactName,
      contactEmail: p.contactEmail,
      contactPhone: p.contactPhone,
      protocol: p.protocol,
      status: p.status,
      notes: p.notes,
      routingRuleCount: p._count.routingRules,
      createdAt: p.createdAt.toISOString(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const contactName = typeof body?.contactName === "string" && body.contactName.trim() ? body.contactName.trim() : null;
  const contactEmail = typeof body?.contactEmail === "string" && body.contactEmail.trim() ? body.contactEmail.trim() : null;
  const contactPhone = typeof body?.contactPhone === "string" && body.contactPhone.trim() ? body.contactPhone.trim() : null;
  const protocol = typeof body?.protocol === "string" && body.protocol.trim() ? body.protocol.trim() : null;
  const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const provider = await prisma.liquidityProvider.create({
    data: { brokerId: session.brokerId!, name, contactName, contactEmail, contactPhone, protocol, notes },
  });

  await prisma.auditLog.create({
    data: {
      brokerId: session.brokerId!,
      actorAdminId: session.adminId,
      action: "LP_CREATED",
      entityType: "LiquidityProvider",
      entityId: provider.id,
      newValue: { name, status: provider.status },
    },
  });

  return NextResponse.json({ id: provider.id }, { status: 201 });
}
