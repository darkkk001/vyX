import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import TeamManager, { type AdminRow } from "./TeamManager";

// Finance/admin-tier screen -- same BROKER_ADMIN-only carve-out as
// Funds/KYC/IB, not the broader MANAGER+BROKER_ADMIN gate.
export default async function ManageTeamPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const admins = await prisma.adminUser.findMany({
    where: { brokerId },
    orderBy: { createdAt: "desc" },
  });

  const rows: AdminRow[] = admins.map((a) => ({
    id: a.id,
    email: a.email,
    // where: { brokerId } guarantees this is never SUPER_ADMIN (always
    // brokerId null) -- see AdminRow's own comment.
    role: a.role as AdminRow["role"],
    status: a.status,
    lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString().replace("T", " ").slice(0, 19) : null,
  }));

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader title="Team" description={`${rows.length} admin${rows.length === 1 ? "" : "s"} for this broker.`} />
      <TeamManager initialRows={rows} currentAdminId={session!.adminId} />
    </main>
  );
}
