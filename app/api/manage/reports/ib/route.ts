import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { computePendingCommission } from "@/lib/commission";
import { toCsv } from "@/lib/csv";
import { formatCsvNumber } from "@/lib/format";

export async function GET() {
  const session = await getAdminSession();
  // Phase 2 batch 6 (issues 131 / 158): pending IB commission is finance data -- BROKER_ADMIN or IB_PAYOUTS, the same
  // gate as the IB screen and the payout (app/api/manage/ib-relationships); any MANAGER could read it before
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
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
      pendingCommission: formatCsvNumber((await computePendingCommission(prisma, r)).toString()),
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
