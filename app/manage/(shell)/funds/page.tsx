import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import FundsRequestsManager from "./FundsRequestsManager";

// Finance screen -- BROKER_ADMIN by default since approving/rejecting
// real money movement is squarely the "not KYC/finance" carve-out from
// AdminRole.MANAGER's own schema comment, but delegatable via
// FUNDS_APPROVAL (see lib/permissions.ts). Kept its own check here --
// stricter than the shell layout's own MANAGER-or-BROKER_ADMIN guard,
// same reasoning as Settings/Emergency/KYC.
export default async function ManagerFundsPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "FUNDS_APPROVAL")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        title="Funds"
        description="Deposit and withdrawal requests submitted by traders. Approving moves real balance; rejecting leaves it untouched. Withdrawals require two different staff members (maker-checker)."
      />
      <FundsRequestsManager />
    </main>
  );
}
