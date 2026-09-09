"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatPercent, formatNumber, formatPnl } from "@/lib/format";

export type RiskRadarRow = {
  accountId: string;
  accountNumber: string;
  trades30d: number;
  winRatePct: number | null;
  avgHoldMinutes: number | null;
  avgLot: number | null;
  profitVelocityPerDay: number;
  scalpFlag: boolean;
  martingaleFlag: boolean;
  latencyArbFlag: boolean;
  newsTraderFlag: boolean;
};

export type SameIpAccount = { accountId: string; accountNumber: string; fullName: string; email: string };
export type SameIpCluster = { ipAddress: string; accounts: SameIpAccount[] };

type SortKey = "trades30d" | "winRatePct" | "avgHoldMinutes" | "avgLot" | "profitVelocityPerDay";

const FLAG_TOOLTIPS = {
  scalp: "Heuristic: average trade hold time under 2 minutes over the last 30 days. Not a rule violation by itself, a flag for review, not an accusation.",
  martingale: "Heuristic: lot size at least 1.5x the previous trade's size, immediately after a loss, repeated 3+ times in the last 30 days.",
  latencyArb: "Heuristic: 10+ trades closed within 3 seconds of opening in the last 30 days, whose win rate is 25+ points above this account's own overall win rate, consistent with exploiting stale-quote windows, not just fast trading.",
  news: "Not available. No historical economic-calendar data source exists yet (the configured Finnhub key doesn't include calendar access, and the existing feed is forward-looking only). Always false until that's resolved.",
} as const;

// Impression Pack #4 -- self-fetches from /api/manage/risk-radar (same
// "both the website and a bundled manager-shell desktop app share this
// one path" convention every other Manager page in this codebase uses).
// onOpenAccount defaults to a hard navigation for the website; a bundled
// shell overrides it to switch in-memory state instead (same pattern as
// AccountsManager.tsx's own onOpenAccount).
export default function RiskRadarManager({ onOpenAccount }: { onOpenAccount?: (accountId: string) => void } = {}) {
  const [rows, setRows] = useState<RiskRadarRow[] | null>(null);
  const [sameIpClusters, setSameIpClusters] = useState<SameIpCluster[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("profitVelocityPerDay");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    fetch("/api/manage/risk-radar")
      .then((r) => r.json())
      .then((payload: { rows: RiskRadarRow[]; sameIpClusters: SameIpCluster[] }) => {
        setRows(payload.rows);
        setSameIpClusters(payload.sameIpClusters ?? []);
      })
      .catch(() => setRows([]));
  }, []);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function openAccount(accountId: string) {
    if (onOpenAccount) onOpenAccount(accountId);
    else window.location.href = `/manage/accounts/${accountId}`;
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  const sortableHeaderStyle = { cursor: "pointer", userSelect: "none" as const };

  return (
    <div className="flex flex-col gap-6">
    {sameIpClusters.length > 0 ? (
      <div className="rounded-lg border border-[var(--border-2)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-1)] mb-1">Same-IP multi-account ({sameIpClusters.length})</h3>
        <p className="text-xs text-[var(--text-3)] mb-3">
          Two or more accounts under DIFFERENT emails logged in from the same IP in the last 30 days, which can mean
          bonus abuse, collusion, or one person running multiple accounts. Shared IPs have real innocent causes too
          (family wifi, corporate NAT), so review each cluster; this is not an automatic action.
        </p>
        <div className="flex flex-col gap-3">
          {sameIpClusters.map((cluster) => (
            <div key={cluster.ipAddress} className="text-sm">
              <span className="font-mono text-[var(--text-2)]">{cluster.ipAddress}</span>
              <span className="text-[var(--text-3)]"> : {cluster.accounts.length} accounts: </span>
              {cluster.accounts.map((a, i) => (
                <span key={a.accountId}>
                  <button
                    className="font-mono text-[var(--accent)] underline underline-offset-2 hover:opacity-80"
                    onClick={() => openAccount(a.accountId)}
                  >
                    {a.accountNumber}
                  </button>
                  <span className="text-[var(--text-3)]"> ({a.fullName}, {a.email})</span>
                  {i < cluster.accounts.length - 1 ? <span className="text-[var(--text-3)]">, </span> : null}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    ) : null}
    <Table>
      <TableHead>
        <TableHeaderCell>Account</TableHeaderCell>
        <TableHeaderCell align="right" style={sortableHeaderStyle} onClick={() => toggleSort("trades30d")}>Trades (30d){sortIndicator("trades30d")}</TableHeaderCell>
        <TableHeaderCell align="right" style={sortableHeaderStyle} onClick={() => toggleSort("winRatePct")}>Win rate{sortIndicator("winRatePct")}</TableHeaderCell>
        <TableHeaderCell align="right" style={sortableHeaderStyle} onClick={() => toggleSort("avgHoldMinutes")}>Avg hold{sortIndicator("avgHoldMinutes")}</TableHeaderCell>
        <TableHeaderCell align="right" style={sortableHeaderStyle} onClick={() => toggleSort("avgLot")}>Avg lot{sortIndicator("avgLot")}</TableHeaderCell>
        <TableHeaderCell align="right" style={sortableHeaderStyle} onClick={() => toggleSort("profitVelocityPerDay")}>$/day{sortIndicator("profitVelocityPerDay")}</TableHeaderCell>
        <TableHeaderCell>Flags</TableHeaderCell>
      </TableHead>
      <TableBody>
        {sorted.length === 0 ? (
          <TableEmptyState colSpan={7}>No accounts with closed trades in the last 30 days.</TableEmptyState>
        ) : (
          sorted.map((row) => (
            <TableRow key={row.accountId} className="cursor-pointer" onClick={() => openAccount(row.accountId)}>
              <TableCell primary mono>{row.accountNumber}</TableCell>
              <TableCell align="right" mono>{row.trades30d}</TableCell>
              <TableCell align="right" mono>{row.winRatePct != null ? formatPercent(row.winRatePct, 0, false) : "-"}</TableCell>
              <TableCell align="right" mono>{row.avgHoldMinutes != null ? `${row.avgHoldMinutes.toFixed(1)}m` : "-"}</TableCell>
              <TableCell align="right" mono>{row.avgLot != null ? formatNumber(row.avgLot) : "-"}</TableCell>
              <TableCell align="right" mono className={formatPnl(row.profitVelocityPerDay).toneClass}>
                {formatPnl(row.profitVelocityPerDay).text}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-1.5">
                  {row.scalpFlag ? <span title={FLAG_TOOLTIPS.scalp}><Badge tone="warning">Scalp</Badge></span> : null}
                  {row.martingaleFlag ? <span title={FLAG_TOOLTIPS.martingale}><Badge tone="danger">Martingale</Badge></span> : null}
                  {row.latencyArbFlag ? <span title={FLAG_TOOLTIPS.latencyArb}><Badge tone="danger">Latency arb</Badge></span> : null}
                  {row.newsTraderFlag ? <span title={FLAG_TOOLTIPS.news}><Badge tone="neutral">News</Badge></span> : null}
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
    </div>
  );
}
