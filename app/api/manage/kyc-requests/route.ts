import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessPermissionOrSupportReader } from "@/lib/permissions";

// BROKER_ADMIN by default -- docs/authentication.md names KYC approval as
// the explicit example of something a MANAGER (dealing desk) shouldn't be
// able to do -- but delegatable via KYC_REVIEW, see lib/permissions.ts.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessPermissionOrSupportReader(session, "KYC_REVIEW") /* SUPPORT reads (view only) */) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  // Phase 2 batch 6 (issue 135): every PENDING record (the queue a reviewer works off), then the latest 200 reviewed
  // ones -- a pending record beyond the old 200-row cap was never listed. Same shape and order as before.
  const include = { account: { select: { accountNumber: true, fullName: true, country: true, phone: true } } };
  const [pending, reviewed] = await Promise.all([
    prisma.kycRecord.findMany({ where: { account: { brokerId }, status: "PENDING" }, include, orderBy: { createdAt: "desc" } }),
    prisma.kycRecord.findMany({ where: { account: { brokerId }, status: { not: "PENDING" } }, include, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200 }),
  ]);
  const records = [...pending, ...reviewed];

  return NextResponse.json(
    records.map((r) => ({
      id: r.id,
      status: r.status,
      documentType: r.documentType,
      rejectionReason: r.rejectionReason,
      hasAddressProof: r.addressProofUrl != null, // issue 134: viewable at .../document?side=address
      accountNumber: r.account.accountNumber,
      accountFullName: r.account.fullName,
      accountCountry: r.account.country,
      accountPhone: r.account.phone,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}
