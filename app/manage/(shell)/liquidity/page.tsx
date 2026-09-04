import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import LiquidityManager from "./LiquidityManager";

// BROKER_ADMIN only, not delegatable -- structural business/contractual
// decisions, same category as Team/Settings. Pre-integration record-
// keeping only -- see LiquidityProvider's schema comment. Kept its own
// check here -- stricter than the shell layout's own MANAGER-or-
// BROKER_ADMIN guard, same reasoning as Settings/Emergency/Team.
export const metadata: Metadata = { title: "Liquidity providers - Backoffice" };

export default async function ManagerLiquidityPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Liquidity providers"
        description="Pre-integration roster only -- no real LP connection exists yet. Status is manually tracked, not detected."
      />
      <LiquidityManager />
    </main>
  );
}
