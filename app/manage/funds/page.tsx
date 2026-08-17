import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import FundsRequestsManager, { type FundsRequestRow } from "./FundsRequestsManager";

// Finance-only screen -- unlike Symbols/Positions/Groups, MANAGER can't
// reach this at all (redirected below), not just UI-hidden, since
// approving/rejecting real money movement is squarely the "not
// KYC/finance" carve-out from AdminRole.MANAGER's own schema comment.
export default async function ManagerFundsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const requests = await prisma.transaction.findMany({
    where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
    include: { account: { select: { accountNumber: true, fullName: true, balance: true } } },
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
    createdAt: t.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <h1>Funds</h1>
      <p style={{ color: "#666" }}>
        Deposit and withdrawal requests submitted by traders. Approving moves real balance;
        rejecting leaves it untouched.
      </p>
      <FundsRequestsManager initialRows={rows} />
    </main>
  );
}
