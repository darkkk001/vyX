import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import PaymentMethodsManager from "./PaymentMethodsManager";

// BROKER_ADMIN-only, same stricter-than-layout carve-out as
// app/manage/(shell)/settings/page.tsx (financial config a broker's own
// team controls) -- see that page's own comment for why this check is
// duplicated rather than relying on the shell layout's looser
// MANAGER-or-BROKER_ADMIN guard.
export const metadata: Metadata = { title: "Payment methods — Backoffice" };

export default async function ManagerPaymentMethodsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) {
    redirect("/manage/login");
  }

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Payment methods"
        description="Deposit/withdrawal methods traders can use, and the min/max/fee limits on each. A method with no saved row yet is disabled by default — saving it turns it on."
      />
      <PaymentMethodsManager />
    </main>
  );
}
