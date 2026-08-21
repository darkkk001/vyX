import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PLAN_PRICING, formatUsd } from "@/lib/billing";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import BrokersManager, { type BrokerRow } from "./BrokersManager";

export default async function BrokersPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const [brokers, totalEndClients] = await Promise.all([
    prisma.broker.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.account.count(),
  ]);

  const rows: BrokerRow[] = brokers.map((b) => ({
    id: b.id,
    name: b.name,
    subdomain: b.subdomain,
    customDomain: b.customDomain,
    tier: b.tier,
    status: b.status,
    executionEngine: b.executionEngine,
    trialEndsAt: b.trialEndsAt ? b.trialEndsAt.toISOString() : null,
    createdAt: b.createdAt.toISOString().slice(0, 10),
    hasSsoSecret: b.ssoSecret != null,
  }));

  const activeCount = brokers.filter((b) => b.status === "ACTIVE").length;
  const trialCount = brokers.filter((b) => b.status === "TRIAL").length;
  const mrrCents = brokers.filter((b) => b.status === "ACTIVE").reduce((sum, b) => sum + PLAN_PRICING[b.tier].monthlyCents, 0);

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="All brokers" description="Every broker tenant licensed on VyXTrader" />
      <StatGrid columns={5}>
        <StatCard label="Total tenants" value={String(brokers.length)} />
        <StatCard label="Active (paying)" value={String(activeCount)} />
        <StatCard label="Trial" value={String(trialCount)} valueTone={trialCount > 0 ? "warn" : undefined} />
        <StatCard label="MRR" value={formatUsd(mrrCents)} />
        <StatCard label="Total end-clients" value={totalEndClients.toLocaleString("en-US")} />
      </StatGrid>
      <BrokersManager initialRows={rows} />
    </main>
  );
}
