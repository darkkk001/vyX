import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import FundsRequestsManager, { type FundsRequestRow } from "./FundsRequestsManager";

// Finance screen -- BROKER_ADMIN by default since approving/rejecting
// real money movement is squarely the "not KYC/finance" carve-out from
// AdminRole.MANAGER's own schema comment, but delegatable via
// FUNDS_APPROVAL (see lib/permissions.ts).
export default async function ManagerFundsPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "FUNDS_APPROVAL")) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const requests = await prisma.transaction.findMany({
    where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
    include: {
      account: { select: { accountNumber: true, fullName: true, balance: true } },
      markedByAdmin: { select: { email: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const rows: FundsRequestRow[] = requests.map((t) => ({
    id: t.id,
    type: t.type as "DEPOSIT" | "WITHDRAWAL",
    status: t.status,
    amount: t.amount.toString(),
    note: t.note,
    accountNumber: t.account.accountNumber,
    accountFullName: t.account.fullName,
    currentBalance: t.account.balance.toString(),
    markedByAdminId: t.markedByAdminId,
    markedByAdminEmail: t.markedByAdmin?.email ?? null,
    createdAt: t.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        title="Funds"
        description="Deposit and withdrawal requests submitted by traders. Approving moves real balance; rejecting leaves it untouched. Withdrawals require two different staff members (maker-checker)."
      />
      <FundsRequestsManager initialRows={rows} currentAdminId={session!.adminId} />
    </main>
  );
}
