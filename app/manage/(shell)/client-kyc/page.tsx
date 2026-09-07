import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import ClientKycRequestsManager from "./ClientKycRequestsManager";

// Client Portal counterpart to app/manage/(shell)/kyc/page.tsx -- same
// BROKER_ADMIN-by-default, KYC_REVIEW-delegatable guard.
export const metadata: Metadata = { title: "Client KYC - Backoffice" };

export default async function ManagerClientKycPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-6xl">
      <PageHeader
        title="Client KYC"
        description="Client Portal identity verification and suitability questionnaire submissions. View documents before approving or rejecting."
      />
      <ClientKycRequestsManager />
    </main>
  );
}
