import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/PageHeader";
import TransfersManager from "./TransfersManager";

// BROKER_ADMIN by default -- same finance carve-out as Funds/adjust-
// balance -- delegatable via INTERNAL_TRANSFERS (see lib/permissions.ts).
// Kept its own check here -- stricter than the shell layout's own
// MANAGER-or-BROKER_ADMIN guard, same reasoning as Settings/Emergency.
export const metadata: Metadata = { title: "Internal transfers - Backoffice" };

export default async function ManagerTransfersPage() {
  const session = await getAdminSession();
  if (await forbidUnlessBrokerAdminOrPermission(session, "INTERNAL_TRANSFERS")) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Internal transfers" description="Move balance between two accounts. Both sides are ledger-backed." />
      <TransfersManager />
    </main>
  );
}
