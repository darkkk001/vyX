import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import TeamManager from "./TeamManager";

// Finance/admin-tier screen -- same BROKER_ADMIN-only carve-out as
// Funds/KYC/IB, not the broader MANAGER+BROKER_ADMIN gate. Kept its own
// check here -- stricter than the shell layout's own MANAGER-or-
// BROKER_ADMIN guard, same reasoning as Settings/Emergency/KYC/Funds.
export default async function ManageTeamPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Team" />
      <TeamManager />
    </main>
  );
}
