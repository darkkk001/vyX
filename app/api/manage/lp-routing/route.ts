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

// Intended routing, not live routing -- see LpRoutingRule's schema
// comment. No execution path reads this yet.
export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rules = await prisma.lpRoutingRule.findMany({
    where: { brokerId: session.brokerId! },
    include: {
      liquidityProvider: { select: { name: true, status: true } },
      symbol: { select: { name: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json(
    rules.map((r) => ({
      id: r.id,
      liquidityProviderId: r.liquidityProviderId,
      liquidityProviderName: r.liquidityProvider.name,
      liquidityProviderStatus: r.liquidityProvider.status,
      symbolName: r.symbol?.name ?? null,
      priority: r.priority,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);
  const liquidityProviderId = typeof body?.liquidityProviderId === "string" ? body.liquidityProviderId : "";
  if (!liquidityProviderId) {
    return NextResponse.json({ error: "liquidityProviderId is required" }, { status: 400 });
  }
  const provider = await prisma.liquidityProvider.findUnique({ where: { id: liquidityProviderId } });
  if (!provider || provider.brokerId !== brokerId) {
    return NextResponse.json({ error: "liquidity provider not found" }, { status: 404 });
  }

  let symbolId: string | null = null;
  if (typeof body?.symbolId === "string" && body.symbolId) {
    const symbol = await prisma.symbol.findUnique({ where: { id: body.symbolId } });
    if (!symbol) {
      return NextResponse.json({ error: "symbol not found" }, { status: 404 });
    }
    symbolId = symbol.id;
  }

  const priority = Number.isFinite(Number(body?.priority)) ? Math.trunc(Number(body.priority)) : 1;
  if (priority <= 0) {
    return NextResponse.json({ error: "priority must be a positive integer" }, { status: 400 });
  }
  const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const rule = await prisma.lpRoutingRule.create({
    data: { brokerId, liquidityProviderId, symbolId, priority, notes },
  });

  return NextResponse.json({ id: rule.id }, { status: 201 });
}
