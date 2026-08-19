import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computePendingCommission } from "@/lib/commission";
import { toCsv } from "@/lib/csv";

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const relationships = await prisma.ibRelationship.findMany({
    where: { brokerId },
    include: {
      ibAccount: { select: { accountNumber: true } },
      clientAccount: { select: { accountNumber: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows = await Promise.all(
    relationships.map(async (r) => ({
      ibAccount: r.ibAccount.accountNumber,
      clientAccount: r.clientAccount.accountNumber,
      commissionType: r.commissionType,
      commissionRate: r.commissionRate.toString(),
      pendingCommission: (await computePendingCommission(prisma, r)).toFixed(4),
      lastPayoutAt: r.lastPayoutAt ? r.lastPayoutAt.toISOString() : "",
    }))
  );

  const csv = toCsv(rows, [
    { key: "ibAccount", label: "IB Account" },
    { key: "clientAccount", label: "Client Account" },
    { key: "commissionType", label: "Commission Type" },
    { key: "commissionRate", label: "Commission Rate" },
    { key: "pendingCommission", label: "Pending Commission" },
    { key: "lastPayoutAt", label: "Last Payout At" },
  ]);

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="ib-report.csv"' },
  });
}
