import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeAccountMarginSnapshots } from "@/lib/margin";

// Same computation app/manage/(shell)/margin/page.tsx's Server Component
// used to do inline -- exposed as JSON so MarginManager can fetch it
// itself (both the website and a bundled manager-shell desktop app use
// this one path now).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const snapshots = await computeAccountMarginSnapshots(prisma, session!.brokerId!);
  const rows = snapshots
    .map((s) => ({
      accountId: s.accountId,
      accountNumber: s.accountNumber,
      positionCount: s.positionCount,
      exposure: s.exposure.toFixed(2),
      floatingPnl: (s.equity - s.balance).toFixed(2),
      marginLevel: s.marginLevel,
      marginCallLevel: s.marginCallLevel,
      stopOutLevel: s.stopOutLevel,
    }))
    .sort((a, b) => (a.marginLevel ?? Infinity) - (b.marginLevel ?? Infinity));

  return NextResponse.json(rows);
}
