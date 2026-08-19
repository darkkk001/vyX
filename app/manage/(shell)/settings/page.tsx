import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import SettingsManager from "./SettingsManager";

export default async function ManagerSettingsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! } });

  return (
    <main className="mx-auto max-w-2xl">
      <PageHeader title="System settings" description="Broker info (read-only — edited in the Super Admin console) and defaults this team controls." />
      <SettingsManager
        broker={{
          name: broker.name,
          subdomain: broker.subdomain,
          customDomain: broker.customDomain,
          tier: broker.tier,
          status: broker.status,
        }}
        initial={{
          defaultAccountCurrency: broker.defaultAccountCurrency,
          defaultAccountLeverage: broker.defaultAccountLeverage,
        }}
      />
    </main>
  );
}
