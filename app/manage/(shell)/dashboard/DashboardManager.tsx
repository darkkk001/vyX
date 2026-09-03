"use client";

import { useEffect, useState } from "react";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { PageLoading, PageError } from "@/components/ui/TableExtras";

type ActivityRow = { id: string; actionLabel: string; actorEmail: string; entityId: string; createdAtLabel: string };

type DashboardData = {
  totalClients: number;
  newClients7d: number;
  depositsSum30d: number;
  activeTrades: number;
  activeTradeAccountCount: number;
  pendingKyc: number;
  pendingWithdrawalCount: number;
  pendingWithdrawalSum: number;
  activity: ActivityRow[];
};

// Self-fetches from a new /api/manage/dashboard GET instead of receiving
// everything as server-rendered props -- this page had no client
// component at all before (the Server Component rendered StatCard/Table
// markup directly), same "no client component yet" special case as the
// Super Admin admins/health pages.
export default function DashboardManager() {
  const [data, setData] = useState<DashboardData | null>(null);
  // Separate from `data` being null -- a fetch failure used to leave
  // `data` null forever with no way to tell "still loading" apart from
  // "the request actually failed" (VYX-BASICS-AUDIT.md category 4).
  const [loadError, setLoadError] = useState(false);

  function load() {
    setLoadError(false);
    fetch("/api/manage/dashboard")
      .then((r) => {
        if (!r.ok) throw new Error(`dashboard fetch failed: ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (loadError) {
    return <PageError onRetry={load} />;
  }
  if (data === null) {
    return <PageLoading />;
  }

  return (
    <>
      <StatGrid columns={5}>
        <StatCard
          label="Total clients"
          value={data.totalClients.toLocaleString("en-US")}
          delta={data.newClients7d > 0 ? `+${data.newClients7d} this week` : undefined}
          deltaTone="pos"
        />
        <StatCard label="Total deposits (30d)" value={`$${data.depositsSum30d.toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
        <StatCard label="Active trades" value={String(data.activeTrades)} delta={`across ${data.activeTradeAccountCount} clients`} />
        <StatCard
          label="Pending KYC"
          value={String(data.pendingKyc)}
          valueTone={data.pendingKyc > 0 ? "warn" : undefined}
          delta={data.pendingKyc > 0 ? "needs review" : undefined}
          deltaTone="warn"
        />
        <StatCard
          label="Pending withdrawals"
          value={String(data.pendingWithdrawalCount)}
          valueTone={data.pendingWithdrawalCount > 0 ? "warn" : undefined}
          delta={data.pendingWithdrawalCount > 0 ? `$${data.pendingWithdrawalSum.toLocaleString("en-US", { minimumFractionDigits: 2 })} total` : undefined}
          deltaTone="warn"
        />
      </StatGrid>

      <Table title="Recent activity">
        <TableHead>
          <TableHeaderCell>Event</TableHeaderCell>
          <TableHeaderCell>Staff</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {data.activity.length === 0 ? (
            <TableEmptyState colSpan={4}>No recent activity.</TableEmptyState>
          ) : (
            data.activity.map((a) => (
              <TableRow key={a.id}>
                <TableCell primary>{a.actionLabel}</TableCell>
                <TableCell className="text-[var(--text-3)]">{a.actorEmail}</TableCell>
                <TableCell mono className="text-[var(--text-3)]">
                  {a.entityId}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{a.createdAtLabel}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </>
  );
}
