import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseRuleFields, ruleSnapshot, RuleInputError } from "@/lib/lp-routing-input";

async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// QoreBridge M5: the rules QoreBridge reads (view HedgeRoutingRule) to pick the provider(s) for a market-book hedge.
// lib/lp-routing-input.ts has the field rules.
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
      group: { select: { name: true, category: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  return NextResponse.json(
    rules.map((r) => ({
      id: r.id,
      liquidityProviderId: r.liquidityProviderId,
      liquidityProviderName: r.liquidityProvider.name,
      liquidityProviderStatus: r.liquidityProvider.status,
      symbolId: r.symbolId,
      symbolName: r.symbol?.name ?? null,
      groupId: r.groupId,
      groupName: r.group?.name ?? null,
      groupCategory: r.group?.category ?? null,
      priority: r.priority,
      weight: r.weight.toString(),
      enabled: r.enabled,
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
  if (typeof body?.liquidityProviderId !== "string" || !body.liquidityProviderId) {
    return NextResponse.json({ error: "liquidityProviderId is required" }, { status: 400 });
  }
  let fields;
  try {
    fields = await parseRuleFields(prisma, brokerId, body);
  } catch (e) {
    if (e instanceof RuleInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const liquidityProviderId = fields.liquidityProviderId!;
  const provider = await prisma.liquidityProvider.findUniqueOrThrow({ where: { id: liquidityProviderId } });

  // Phase 2 batch 5: created and audited together (a rule create used to write no audit row)
  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.lpRoutingRule.create({
      data: {
        brokerId, liquidityProviderId, groupId: fields.groupId ?? null, symbolId: fields.symbolId ?? null, priority: fields.priority ?? 1,
        ...(fields.weight ? { weight: fields.weight } : {}), enabled: fields.enabled ?? true, notes: fields.notes ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "LP_ROUTING_RULE_CREATED",
        entityType: "LpRoutingRule",
        entityId: created.id,
        newValue: { ...ruleSnapshot(created), liquidityProvider: provider.name },
      },
    });
    return created;
  });

  return NextResponse.json({ id: rule.id }, { status: 201 });
}
