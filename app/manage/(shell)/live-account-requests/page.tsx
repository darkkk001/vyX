import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import LiveAccountRequestsManager from "./LiveAccountRequestsManager";

export const metadata: Metadata = { title: "Live Account Requests - Backoffice" };

export default async function ManagerLiveAccountRequestsPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "KYC_REVIEW")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-6xl">
      <PageHeader
        title="Live Account Requests"
        description="Client Portal requests to open a Live trading account, gated on KYC approval. Approving creates the account and emails the client their credentials."
      />
      <LiveAccountRequestsManager />
    </main>
  );
}
