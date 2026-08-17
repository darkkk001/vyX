import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import KycRequestsManager, { type KycRequestRow } from "./KycRequestsManager";

// Finance/backoffice-only screen, same as Funds -- MANAGER can't reach
// this at all (redirected below), not just UI-hidden. See
// docs/authentication.md's own KYC-approval example for why.
export default async function ManagerKycPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const records = await prisma.kycRecord.findMany({
    where: { account: { brokerId } },
    include: { account: { select: { accountNumber: true, fullName: true } } },
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
    createdAt: r.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <h1>KYC</h1>
      <p style={{ color: "#666" }}>
        Identity verification submissions. View front/back document photos before approving or
        rejecting.
      </p>
      <KycRequestsManager initialRows={rows} />
    </main>
  );
}
