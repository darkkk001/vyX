import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseRuleFields, ruleSnapshot, RuleInputError } from "@/lib/lp-routing-input";

/** PATCH: change a rule (provider, group, symbol, failover level, weight, on / off, notes); absent fields stay. Audited
 *  as LP_ROUTING_RULE_CHANGED with the old and new rule; a request that changes nothing writes nothing. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const existing = await prisma.lpRoutingRule.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  let fields;
  try {
    fields = await parseRuleFields(prisma, brokerId, body);
  } catch (e) {
    if (e instanceof RuleInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const before = ruleSnapshot(existing);
  const after = ruleSnapshot({ ...existing, ...fields });
  if (JSON.stringify(before) === JSON.stringify(after)) return NextResponse.json({ ok: true, changed: false });
  await prisma.$transaction(async (tx) => {
    await tx.lpRoutingRule.update({ where: { id }, data: fields });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session!.adminId, action: "LP_ROUTING_RULE_CHANGED", entityType: "LpRoutingRule", entityId: id, oldValue: before, newValue: after },
    });
  });
  return NextResponse.json({ ok: true, changed: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const existing = await prisma.lpRoutingRule.findUnique({ where: { id } });
  if (!existing || existing.brokerId !== session!.brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Phase 2 batch 5: deleted and audited together (a rule delete used to write no audit row)
  await prisma.$transaction(async (tx) => {
    await tx.lpRoutingRule.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        brokerId: session!.brokerId!,
        actorAdminId: session!.adminId,
        action: "LP_ROUTING_RULE_DELETED",
        entityType: "LpRoutingRule",
        entityId: id,
        oldValue: ruleSnapshot(existing),
      },
    });
  });
  return NextResponse.json({ ok: true });
}
