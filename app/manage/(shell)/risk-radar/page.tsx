import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import RiskRadarManager from "./RiskRadarManager";

// No auth check or Prisma query here -- app/manage/(shell)/layout.tsx's
// own MANAGER-or-BROKER_ADMIN guard already covers this route.
export const metadata: Metadata = { title: "Risk Radar — Backoffice" };

export default function RiskRadarPage() {
  return (
    <main className="mx-auto max-w-[1200px]">
      <PageHeader title="Risk Radar" description="Trading-behavior heuristics over the last 30 days -- not rule violations, a starting point for review." />
      <RiskRadarManager />
    </main>
  );
}
