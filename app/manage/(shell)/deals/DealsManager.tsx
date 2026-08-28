"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type DealRow = {
  id: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  openPrice: string;
  closePrice: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  closedAt: string;
};

// Self-fetches from /api/manage/deals instead of receiving rows as a
// server-rendered prop -- both the website and a bundled manager-shell
// desktop app (no Server Component of its own) share this one path now.
export default function DealsManager() {
  const [rows, setRows] = useState<DealRow[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/manage/deals")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (r) => !q || r.accountNumber.toLowerCase().includes(q) || r.accountFullName.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q)
  );

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-3)]">
        {rows.length} closed trade{rows.length === 1 ? "" : "s"} (most recent 500) across this broker.
      </p>
      <Input
        type="text"
        placeholder="Search by account number, name, or symbol..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell>Side</TableHeaderCell>
          <TableHeaderCell align="right">Volume</TableHeaderCell>
          <TableHeaderCell align="right">Open</TableHeaderCell>
          <TableHeaderCell align="right">Close</TableHeaderCell>
          <TableHeaderCell align="right">Commission</TableHeaderCell>
          <TableHeaderCell align="right">Swap</TableHeaderCell>
          <TableHeaderCell align="right">P&L</TableHeaderCell>
          <TableHeaderCell>Closed</TableHeaderCell>
        </TableHead>
        <TableBody>
          {filtered.length === 0 ? (
            <TableEmptyState colSpan={10}>No closed deals match.</TableEmptyState>
          ) : (
            filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.accountFullName}</div>
                </TableCell>
                <TableCell mono>{row.symbol}</TableCell>
                <TableCell>
                  <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge>
                </TableCell>
                <TableCell align="right" mono>{row.volume}</TableCell>
                <TableCell align="right" mono>{row.openPrice}</TableCell>
                <TableCell align="right" mono>{row.closePrice}</TableCell>
                <TableCell align="right" mono>{row.commission}</TableCell>
                <TableCell align="right" mono>{row.swap}</TableCell>
                <TableCell align="right" mono className={row.realizedPnl !== "—" && Number(row.realizedPnl) < 0 ? "text-[var(--sell)]" : "text-[var(--buy)]"}>
                  {row.realizedPnl}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.closedAt}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
