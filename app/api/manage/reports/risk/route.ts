import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeAccountMarginSnapshots } from "@/lib/margin";
import { toCsv } from "@/lib/csv";
import { formatCsvNumber } from "@/lib/format";

// Per-account open-exposure/margin snapshot -- same computation as the
// Risk Dashboard stats and the Margin monitoring page (lib/margin.ts),
// one row per account instead of a broker-wide aggregate.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const snapshots = await computeAccountMarginSnapshots(prisma, session!.brokerId!);

  const rows = snapshots.map((s) => ({
    accountNumber: s.accountNumber,
    openPositions: String(s.positionCount),
    exposure: formatCsvNumber(s.exposure.toString(), 2),
    floatingPnl: formatCsvNumber(s.floatingPnl.toString()), // equity - balance would include credit (Stage 2 F1)
    marginLevel: formatCsvNumber(s.marginLevel?.toString(), 1), // no positions: empty, never 0
    marginCallLevel: formatCsvNumber(s.marginCallLevel.toString(), 1),
    stopOutLevel: formatCsvNumber(s.stopOutLevel.toString(), 1),
  }));

  const csv = toCsv(rows, [
    { key: "accountNumber", label: "Account" },
    { key: "openPositions", label: "Open Positions" },
    { key: "exposure", label: "Exposure (lots)" },
    { key: "floatingPnl", label: "Floating P&L" },
    { key: "marginLevel", label: "Margin Level %" },
    { key: "marginCallLevel", label: "Margin Call Threshold %" },
    { key: "stopOutLevel", label: "Stop-Out Threshold %" },
  ]);

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="risk-report.csv"' },
  });
}
