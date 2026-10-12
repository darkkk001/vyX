import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { markIsEmpty, nextMark, NO_MARK, type RiskMark } from "@/lib/risk-marks";

// Step 3b item 6 (owner 2026-10-07): Risk radar, flag / whitelist / note for one account. The radar's own audience: a manager or a
// broker admin, same broker. Body: any of { flagged, whitelisted, note }; only what is sent changes. Audited with old and new.
// Moves no money and blocks nothing: it changes what the radar and its badge show.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ accountId: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const { accountId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "send flagged, whitelisted and / or note" }, { status: 400 });
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, brokerId: true, accountNumber: true } });
  if (!account || account.brokerId !== brokerId) return NextResponse.json({ error: "account not found" }, { status: 404 });

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.riskAccountMark.findUnique({ where: { accountId } });
    const before: RiskMark = row ? { flagged: row.flagged, whitelisted: row.whitelisted, note: row.note } : NO_MARK;
    const next = nextMark(before, body as Record<string, unknown>);
    if (!next.ok) return next;
    if (markIsEmpty(next.mark)) { if (row) await tx.riskAccountMark.delete({ where: { accountId } }); }
    else await tx.riskAccountMark.upsert({ where: { accountId }, create: { brokerId, accountId, ...next.mark, updatedByAdminId: session!.adminId }, update: { ...next.mark, updatedByAdminId: session!.adminId } });
    await tx.auditLog.create({
      data: { brokerId, actorAdminId: session!.adminId, action: "RISK_MARK_UPDATED", entityType: "Account", entityId: accountId, oldValue: { ...before }, newValue: { ...next.mark, accountNumber: account.accountNumber } },
    });
    return next;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ accountId, ...result.mark });
}
