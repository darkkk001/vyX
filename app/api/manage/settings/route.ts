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

// BROKER_ADMIN only, same carve-out as Risk/Emergency. Editing branding/
// tier/status stays Super Admin's job -- this route only covers
// defaults a broker's own team should control.
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId! } });
  return NextResponse.json({
    name: broker.name,
    subdomain: broker.subdomain,
    customDomain: broker.customDomain,
    tier: broker.tier,
    status: broker.status,
    defaultAccountCurrency: broker.defaultAccountCurrency,
    defaultAccountLeverage: broker.defaultAccountLeverage,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const data: { defaultAccountCurrency?: string; defaultAccountLeverage?: number } = {};

  if (typeof body?.defaultAccountCurrency === "string" && body.defaultAccountCurrency.trim()) {
    data.defaultAccountCurrency = body.defaultAccountCurrency.trim().toUpperCase();
  }
  if (body?.defaultAccountLeverage != null) {
    const n = Math.trunc(Number(body.defaultAccountLeverage));
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "defaultAccountLeverage must be a positive integer" }, { status: 400 });
    }
    data.defaultAccountLeverage = n;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const updated = await prisma.broker.update({ where: { id: brokerId }, data });
  return NextResponse.json({
    defaultAccountCurrency: updated.defaultAccountCurrency,
    defaultAccountLeverage: updated.defaultAccountLeverage,
  });
}
