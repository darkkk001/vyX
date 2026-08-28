import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// BROKER_ADMIN by default -- docs/authentication.md names KYC approval as
// the explicit example of something a MANAGER (dealing desk) shouldn't be
// able to do -- but delegatable via KYC_REVIEW, see lib/permissions.ts.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const records = await prisma.kycRecord.findMany({
    where: { account: { brokerId } },
    include: { account: { select: { accountNumber: true, fullName: true, country: true, phone: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json(
    records.map((r) => ({
      id: r.id,
      status: r.status,
      documentType: r.documentType,
      rejectionReason: r.rejectionReason,
      accountNumber: r.account.accountNumber,
      accountFullName: r.account.fullName,
      accountCountry: r.account.country,
      accountPhone: r.account.phone,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}
