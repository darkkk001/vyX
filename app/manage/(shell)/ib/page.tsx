import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computePendingCommission } from "@/lib/commission";
import { PageHeader } from "@/components/ui/PageHeader";
import IbRelationshipsManager, { type IbRelationshipRow, type AccountOption } from "./IbRelationshipsManager";

// Finance-adjacent screen (payout moves real balance) -- BROKER_ADMIN
// only, same carve-out as Funds/KYC, not just UI-hidden for MANAGER.
export default async function ManageIbPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const [relationships, accounts] = await Promise.all([
    prisma.ibRelationship.findMany({
      where: { brokerId },
      include: {
        ibAccount: { select: { accountNumber: true, fullName: true } },
        clientAccount: { select: { accountNumber: true, fullName: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.account.findMany({
      where: { brokerId, status: "ACTIVE" },
      select: { id: true, accountNumber: true, fullName: true, ibLinkAsClient: { select: { id: true } } },
      orderBy: { accountNumber: "asc" },
    }),
  ]);

  const rows: IbRelationshipRow[] = await Promise.all(
    relationships.map(async (r) => ({
      id: r.id,
      ibAccountId: r.ibAccountId,
      ibAccountNumber: r.ibAccount.accountNumber,
      ibAccountFullName: r.ibAccount.fullName,
      clientAccountId: r.clientAccountId,
      clientAccountNumber: r.clientAccount.accountNumber,
      clientAccountFullName: r.clientAccount.fullName,
      commissionType: r.commissionType,
      commissionRate: r.commissionRate.toString(),
      pendingCommission: (await computePendingCommission(prisma, r)).toFixed(4),
      lastPayoutAt: r.lastPayoutAt ? r.lastPayoutAt.toISOString().replace("T", " ").slice(0, 19) : null,
    }))
  );

  // Any ACTIVE account can be an IB (even one that already has clients of
  // its own). Only accounts with no existing ibLinkAsClient can be picked
  // as a new client -- clientAccountId is @unique, so offering an
  // already-linked account here would just be a guaranteed 409.
  const ibOptions: AccountOption[] = accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));
  const clientOptions: AccountOption[] = accounts
    .filter((a) => !a.ibLinkAsClient)
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        title="Introducing Brokers"
        description={`${rows.length} relationship${rows.length === 1 ? "" : "s"}. Pending commission is calculated from each client's closed trades since the last payout.`}
      />
      <IbRelationshipsManager initialRows={rows} ibOptions={ibOptions} clientOptions={clientOptions} />
    </main>
  );
}
