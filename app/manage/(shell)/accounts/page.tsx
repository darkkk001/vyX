import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import AccountsManager, { type AccountRow, type GroupOption } from "./AccountsManager";

export default async function ManagerAccountsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const [accounts, groups] = await Promise.all([
    prisma.account.findMany({
      where: { brokerId },
      include: { group: { select: { id: true, name: true } } },
      orderBy: { accountNumber: "asc" },
    }),
    prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const rows: AccountRow[] = accounts.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    fullName: a.fullName,
    email: a.email,
    accountType: a.accountType,
    currency: a.currency,
    leverage: a.leverage,
    balance: a.balance.toString(),
    credit: a.credit.toString(),
    status: a.status,
    groupId: a.groupId,
    groupName: a.group?.name ?? null,
    maxDailyLoss: a.maxDailyLoss ? a.maxDailyLoss.toString() : null,
  }));

  const groupOptions: GroupOption[] = groups.map((g) => ({ id: g.id, name: g.name }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Accounts"
        description={`${rows.length} account${rows.length === 1 ? "" : "s"} for this broker.${
          session!.role !== "BROKER_ADMIN" ? " Leverage/status/balance changes require a Broker Admin login." : ""
        }`}
      />
      <AccountsManager initialRows={rows} groups={groupOptions} canManageFinance={session!.role === "BROKER_ADMIN"} />
    </main>
  );
}
