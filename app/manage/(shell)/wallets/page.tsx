import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import WalletsManager, { type WalletRow } from "./WalletsManager";

// A view of each account's existing balance/credit -- not a separate
// multi-currency wallet system, which would need a Client entity above
// Account this schema deliberately doesn't have (see Account's own
// schema comment). Confirmed with the user.
export default async function ManagerWalletsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const accounts = await prisma.account.findMany({
    where: { brokerId },
    select: { id: true, accountNumber: true, fullName: true, currency: true, balance: true, credit: true, status: true },
    orderBy: { accountNumber: "asc" },
  });

  const rows: WalletRow[] = accounts.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    fullName: a.fullName,
    currency: a.currency,
    balance: a.balance.toFixed(2),
    credit: a.credit.toFixed(2),
    status: a.status,
  }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Wallets" description="Balance and credit per account." />
      <WalletsManager initialRows={rows} />
    </main>
  );
}
