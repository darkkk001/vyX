"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatNumber, formatPnl, formatPercent } from "@/lib/format";

export type MarginRow = {
  accountId: string;
  accountNumber: string;
  positionCount: number;
  exposure: string;
  floatingPnl: string;
  marginLevel: number | null;
  marginCallLevel: number;
  stopOutLevel: number;
};

function statusFor(row: MarginRow): { label: string; tone: "danger" | "warning" | "success" | "neutral" } {
  if (row.marginLevel == null) return { label: "NO FEED", tone: "neutral" };
  if (row.marginLevel < row.stopOutLevel) return { label: "STOP-OUT", tone: "danger" };
  if (row.marginLevel < row.marginCallLevel) return { label: "MARGIN CALL", tone: "warning" };
  return { label: "OK", tone: "success" };
}

// Self-fetches from /api/manage/margin instead of receiving rows as a
// server-rendered prop -- both the website and a bundled manager-shell
// desktop app (no Server Component of its own) share this one path now.
export default function MarginManager() {
  const [rows, setRows] = useState<MarginRow[] | null>(null);

  useEffect(() => {
    fetch("/api/manage/margin")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Account</TableHeaderCell>
        <TableHeaderCell align="right">Open positions</TableHeaderCell>
        <TableHeaderCell align="right">Exposure</TableHeaderCell>
        <TableHeaderCell align="right">Floating P&L</TableHeaderCell>
        <TableHeaderCell align="right">Margin level</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={6}>No accounts with open positions.</TableEmptyState>
        ) : (
          rows.map((row) => {
            const status = statusFor(row);
            return (
              <TableRow key={row.accountId}>
                <TableCell primary mono>{row.accountNumber}</TableCell>
                <TableCell align="right" mono>{row.positionCount}</TableCell>
                <TableCell align="right" mono>{formatNumber(row.exposure)}</TableCell>
                <TableCell align="right" mono className={formatPnl(row.floatingPnl).toneClass}>
                  {formatPnl(row.floatingPnl).text}
                </TableCell>
                <TableCell align="right" mono>{row.marginLevel != null ? formatPercent(row.marginLevel, 0, false) : "—"}</TableCell>
                <TableCell>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
