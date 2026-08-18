import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import GroupsManager, { type GroupRow } from "./GroupsManager";

// Settings template accounts can be assigned to -- see the Group model's
// own schema comment for the (deliberately narrow) scope of what
// assigning a group actually does today.
export default async function ManagerGroupsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const groups = await prisma.group.findMany({
    where: { brokerId },
    orderBy: { name: "asc" },
  });

  const rows: GroupRow[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    leverage: g.leverage,
    marginCallLevel: g.marginCallLevel.toString(),
    stopOutLevel: g.stopOutLevel.toString(),
    isDefault: g.isDefault,
  }));

  return (
    <main className="mx-auto max-w-3xl">
      <PageHeader
        title="Groups"
        description="Settings templates for accounts — assigning an account to a group applies the group's leverage to that account immediately. Margin-call/stop-out levels are stored here but not yet enforced by the trading engine."
      />
      <GroupsManager initialRows={rows} />
    </main>
  );
}
