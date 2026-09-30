import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { IbPartnerError, resumePartner } from "@/lib/ib-partner";

// Step 2 (owner 2026-09-30): IB "Resume partner…". [id] = the partner's IB account id. BROKER_ADMIN or IB_PAYOUTS.
// The frozen owed pay becomes payable again; trades closed while suspended never accrue. Audited (IB_PARTNER_RESUMED).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const r = await prisma.$transaction((tx) => resumePartner(tx, { brokerId: session!.brokerId!, ibAccountId: id, adminId: session!.adminId }));
    return NextResponse.json({ ibAccountId: id, resumedAt: r.resumedAt.toISOString(), owed: r.owed.toFixed(4) });
  } catch (e) {
    if (e instanceof IbPartnerError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
