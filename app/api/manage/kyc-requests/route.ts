import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// BROKER_ADMIN only -- docs/authentication.md names KYC approval as the
// explicit example of something a MANAGER (dealing desk) shouldn't be
// able to do.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const records = await prisma.kycRecord.findMany({
    where: { account: { brokerId } },
    include: { account: { select: { accountNumber: true, fullName: true } } },
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
      createdAt: r.createdAt.toISOString(),
    }))
  );
}
