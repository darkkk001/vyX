import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import KycRequestsManager from "./KycRequestsManager";
import ClientKycRequestsManager from "../client-kyc/ClientKycRequestsManager";

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
    <main className="mx-auto max-w-6xl">
      <PageHeader
        title="KYC"
        description="Every verification waiting for review. Client Portal submissions (identity documents + suitability) first; in-app WebTrader submissions below."
      />
      {/* 2026-09-11 Futurix live testing: a portal KYC only ever appeared under the separate
          "Client KYC" page (ClientKycRecord) while this page listed KycRecord (the in-app
          WebTrader flow) -- staff looking at "KYC" saw an empty queue. Both queues live here now;
          /manage/client-kyc stays as the focused, deep-linkable view. */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-3)]">Client Portal submissions</h2>
        <ClientKycRequestsManager />
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--text-3)]">In-app (WebTrader) submissions</h2>
        <KycRequestsManager />
      </section>
    </main>
  );
}
