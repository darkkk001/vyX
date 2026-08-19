import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import TransfersManager, { type TransferRow, type AccountOption } from "./TransfersManager";

// BROKER_ADMIN only -- same finance carve-out as Funds/adjust-balance.
export default async function ManagerTransfersPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const [transfers, accounts] = await Promise.all([
    prisma.transaction.findMany({
      where: { brokerId, type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } },
      include: { account: { select: { accountNumber: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.account.findMany({
      where: { brokerId, status: "ACTIVE" },
      select: { id: true, accountNumber: true, fullName: true },
      orderBy: { accountNumber: "asc" },
    }),
  ]);

  const rows: TransferRow[] = transfers.map((t) => ({
    id: t.id,
    accountNumber: t.account.accountNumber,
    type: t.type as "TRANSFER_OUT" | "TRANSFER_IN",
    amount: t.amount.toString(),
    note: t.note,
    createdAt: t.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  const accountOptions: AccountOption[] = accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Internal transfers" description="Move balance between two accounts on this broker. Both sides are ledger-backed." />
      <TransfersManager initialRows={rows} accounts={accountOptions} />
    </main>
  );
}
