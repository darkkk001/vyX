import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";

// Client-level KYC review queue -- same shape/permission as
// app/api/manage/kyc-requests/route.ts (the account-level one), pointed
// at ClientKycRecord instead. Kept as a separate endpoint/page rather
// than merged into that one: the two review different, unrelated
// submission pools (an Account never linked to a Client vs. a Client
// itself), and merging them would mean every row needed a discriminator
// the reviewer has to parse instead of two clearly-labeled queues.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const records = await prisma.clientKycRecord.findMany({
    where: { client: { brokerId } },
    include: { client: { select: { fullName: true, email: true, country: true, phone: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  return NextResponse.json(
    records.map((r) => ({
      id: r.id,
      status: r.status,
      documentType: r.documentType,
      rejectionReason: r.rejectionReason,
      hasAddressProof: r.addressProofUrl != null,
      annualIncome: r.annualIncome,
      sourceOfFunds: r.sourceOfFunds,
      tradingExperience: r.tradingExperience,
      employmentStatus: r.employmentStatus,
      riskTolerance: r.riskTolerance,
      clientFullName: r.client.fullName,
      clientEmail: r.client.email,
      clientCountry: r.client.country,
      clientPhone: r.client.phone,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}
