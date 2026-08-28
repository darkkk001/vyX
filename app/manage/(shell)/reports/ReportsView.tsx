"use client";

import { useEffect, useState } from "react";
import { Table } from "@/components/ui/Table";
import { StatCard, StatGrid } from "@/components/ui/StatCard";

type ReportsSummary = {
  tradingVolume: number;
  commissionRevenue: number;
  netDeposits: number;
  newClients: number;
};

// Stat grid now self-fetches from a new /api/manage/reports/summary
// route (the same four aggregates page.tsx's Server Component used to
// compute inline) instead of receiving them as server-rendered props --
// both the website and a bundled manager-shell desktop app (no Server
// Component of its own) share this one path now. The export links below
// were already portable (plain <a href> same-origin GETs, no client-side
// fetch/blob dance) -- unchanged.
export default function ReportsView() {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);

  useEffect(() => {
    fetch("/api/manage/reports/summary")
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => {});
  }, []);

  return (
    <>
      <StatGrid columns={4}>
        <StatCard label="Trading volume (30d)" value={`${(summary?.tradingVolume ?? 0).toLocaleString("en-US")} lots`} />
        <StatCard label="Commission revenue (30d)" value={`$${(summary?.commissionRevenue ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="Net deposits (30d)" value={`$${(summary?.netDeposits ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="New clients (30d)" value={String(summary?.newClients ?? 0)} />
      </StatGrid>
      <Table title="Export">
        <tbody>
          <tr>
            <td className="flex flex-wrap gap-2.5 p-[18px]">
              <a
                href="/api/manage/reports/trading"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                Trading report (CSV)
              </a>
              <a
                href="/api/manage/reports/financial"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                Financial report (CSV)
              </a>
              <a
                href="/api/manage/reports/client"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                Client report (CSV)
              </a>
              <a
                href="/api/manage/reports/ib"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                IB report (CSV)
              </a>
              <a
                href="/api/manage/reports/risk"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                Risk report (CSV)
              </a>
              <a
                href="/api/manage/reports/lp"
                className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
              >
                LP report (CSV)
              </a>
            </td>
          </tr>
        </tbody>
      </Table>
    </>
  );
}
