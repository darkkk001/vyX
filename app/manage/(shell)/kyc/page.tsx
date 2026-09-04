import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import KycRequestsManager from "./KycRequestsManager";

// BROKER_ADMIN by default, same as Funds -- see docs/authentication.md's
// own KYC-approval example for why -- delegatable via KYC_REVIEW. Kept
// its own check here -- stricter than the shell layout's own
// MANAGER-or-BROKER_ADMIN guard, same reasoning as Settings/Emergency.
export const metadata: Metadata = { title: "KYC - Backoffice" };

export default async function ManagerKycPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        title="KYC"
        description="Identity verification submissions. View front/back document photos before approving or rejecting."
      />
      <KycRequestsManager />
    </main>
  );
}
