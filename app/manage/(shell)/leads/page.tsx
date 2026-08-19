import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import LeadsManager, { type LeadRow } from "./LeadsManager";

export default async function ManagerLeadsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const leads = await prisma.lead.findMany({
    where: { brokerId },
    include: { convertedAccount: { select: { accountNumber: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows: LeadRow[] = leads.map((l) => ({
    id: l.id,
    fullName: l.fullName,
    email: l.email,
    phone: l.phone,
    country: l.country,
    source: l.source,
    status: l.status,
    convertedAccountNumber: l.convertedAccount?.accountNumber ?? null,
    createdAt: l.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Leads" description={`${rows.length} lead${rows.length === 1 ? "" : "s"} for this broker.`} />
      <LeadsManager initialRows={rows} canConvert={session!.role === "BROKER_ADMIN"} />
    </main>
  );
}
