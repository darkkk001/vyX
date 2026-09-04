import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import LpRoutingManager from "./LpRoutingManager";

// BROKER_ADMIN only, same carve-out as the LP roster. Intended routing,
// not live routing -- see LpRoutingRule's schema comment. Kept its own
// check here -- stricter than the shell layout's own MANAGER-or-
// BROKER_ADMIN guard, same reasoning as Settings/Emergency/Transfers.
export const metadata: Metadata = { title: "LP routing rules - Backoffice" };

export default async function ManagerLpRoutingPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-[1200px]">
      <PageHeader
        title="LP routing rules"
        description="Intended routing, recorded before the real integration exists -- no execution path reads this yet."
      />
      <LpRoutingManager />
    </main>
  );
}
