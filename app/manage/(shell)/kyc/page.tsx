import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import KycRequestsManager, { type KycRequestRow } from "./KycRequestsManager";

// BROKER_ADMIN by default, same as Funds -- see docs/authentication.md's
// own KYC-approval example for why -- delegatable via KYC_REVIEW.
export default async function ManagerKycPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const records = await prisma.kycRecord.findMany({
    where: { account: { brokerId } },
    include: { account: { select: { accountNumber: true, fullName: true, country: true, phone: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const rows: KycRequestRow[] = records.map((r) => ({
    id: r.id,
    status: r.status,
    documentType: r.documentType,
    rejectionReason: r.rejectionReason,
    accountNumber: r.account.accountNumber,
    accountFullName: r.account.fullName,
    accountCountry: r.account.country,
    accountPhone: r.account.phone,
    createdAt: r.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        title="KYC"
        description="Identity verification submissions. View front/back document photos before approving or rejecting."
      />
      <KycRequestsManager initialRows={rows} />
    </main>
  );
}
