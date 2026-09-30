import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { IbPartnerError, suspendPartner } from "@/lib/ib-partner";

// Step 2 (owner 2026-09-30): IB "Suspend partner…". [id] = the partner's IB account id. BROKER_ADMIN, or a MANAGER
// with IB_PAYOUTS (the same authority that files partner payouts). Owed pay is frozen, not lost (lib/ib-partner.ts).
// Body: { reason?: string }. Audited (IB_PARTNER_SUSPENDED).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;
  try {
    const r = await prisma.$transaction((tx) => suspendPartner(tx, { brokerId: session!.brokerId!, ibAccountId: id, adminId: session!.adminId, reason }));
    return NextResponse.json({ ibAccountId: id, suspendedAt: r.suspendedAt.toISOString(), frozenOwed: r.frozenOwed.toFixed(4) });
  } catch (e) {
    if (e instanceof IbPartnerError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
