import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import IbRelationshipsManager from "./IbRelationshipsManager";

// Finance-adjacent screen (payout moves real balance) -- BROKER_ADMIN by
// default, same carve-out as Funds/KYC -- delegatable via IB_PAYOUTS
// (see lib/permissions.ts). Kept its own check here -- stricter than the
// shell layout's own MANAGER-or-BROKER_ADMIN guard, same reasoning as
// Settings/Emergency/Transfers. Row/account data now self-fetched by
// IbRelationshipsManager from the already-existing
// /api/manage/ib-relationships and /api/manage/accounts (extended with
// hasIbLink) routes -- both already gated the same way server-side.
export const metadata: Metadata = { title: "Introducing Brokers - Backoffice" };

export default async function ManageIbPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "IB_PAYOUTS")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader title="Introducing Brokers" />
      <IbRelationshipsManager />
    </main>
  );
}
