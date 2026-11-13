import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Live cutover (owner 2026-11-11), DORMANT: one LIVE account's entry on the per-account engine allowlist (Account.engineLiveEnabled).
// The entry counts only while the broker's Broker.engineLiveAllowlistOn is true, which this route never changes (the owner turns that
// flag on separately): with the flag off, setting entries changes nothing anywhere. The engine, the gateway and lib/risk-authority.ts read
// the same two columns -- docs/ENGINE-LIVE-ALLOWLIST.md. BROKER_ADMIN only; a reason is required; every change is audited.
async function load(id: string, brokerId: string) {
  const a = await prisma.account.findUnique({
    where: { id },
    select: { id: true, brokerId: true, accountNumber: true, accountMode: true, engineLiveEnabled: true, broker: { select: { engineLiveAllowlistOn: true } } },
  });
  return a && a.brokerId === brokerId ? a : null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const a = await load(id, session!.brokerId!);
  if (!a) return NextResponse.json({ error: "account not found" }, { status: 404 });
  return NextResponse.json({ accountId: a.id, accountMode: a.accountMode, engineLiveEnabled: a.engineLiveEnabled, allowlistOn: a.broker.engineLiveAllowlistOn });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const enabled = body?.enabled;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (typeof enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "reason is required" }, { status: 400 });
  const a = await load(id, brokerId);
  if (!a) return NextResponse.json({ error: "account not found" }, { status: 404 });
  // only a LIVE account is put on the list (a DEMO account already takes the engine path under the DEMO-only rule)
  if (enabled && a.accountMode !== "LIVE") return NextResponse.json({ error: "only a live account goes on the engine allowlist" }, { status: 409 });
  if (a.engineLiveEnabled === enabled) return NextResponse.json({ accountId: a.id, engineLiveEnabled: enabled, allowlistOn: a.broker.engineLiveAllowlistOn, unchanged: true });
  await prisma.$transaction([
    prisma.account.update({ where: { id: a.id }, data: { engineLiveEnabled: enabled } }),
    prisma.auditLog.create({
      data: {
        brokerId, actorAdminId: session!.adminId, action: "ENGINE_LIVE_ALLOWLIST_SET", entityType: "Account", entityId: a.id,
        oldValue: { engineLiveEnabled: a.engineLiveEnabled }, newValue: { engineLiveEnabled: enabled, accountNumber: a.accountNumber, reason, allowlistOn: a.broker.engineLiveAllowlistOn },
      },
    }),
  ]);
  return NextResponse.json({ accountId: a.id, engineLiveEnabled: enabled, allowlistOn: a.broker.engineLiveAllowlistOn });
}
