"use client";

import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type WalletRow = {
  id: string;
  accountNumber: string;
  fullName: string;
  currency: string;
  balance: string;
  credit: string;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
};

const statusTone = { ACTIVE: "success", SUSPENDED: "warning", CLOSED: "neutral" } as const;

export default function WalletsManager({ initialRows }: { initialRows: WalletRow[] }) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const filtered = q
    ? initialRows.filter((r) => r.accountNumber.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q))
    : initialRows;

  const totalBalance = filtered.reduce((s, r) => s + Number(r.balance), 0);
  const totalCredit = filtered.reduce((s, r) => s + Number(r.credit), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Input type="text" placeholder="Search by account number or name..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
        <div className="text-sm text-[var(--text-3)]">
          Total balance: <span className="font-mono text-[var(--text-1)]">{totalBalance.toFixed(2)}</span> · Total credit:{" "}
          <span className="font-mono text-[var(--text-1)]">{totalCredit.toFixed(2)}</span>
        </div>
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Currency</TableHeaderCell>
          <TableHeaderCell align="right">Balance</TableHeaderCell>
          <TableHeaderCell align="right">Credit</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableHead>
        <TableBody>
          {filtered.length === 0 ? (
            <TableEmptyState colSpan={5}>No accounts match.</TableEmptyState>
          ) : (
            filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.fullName}</div>
                </TableCell>
                <TableCell mono>{row.currency}</TableCell>
                <TableCell align="right" mono>{row.balance}</TableCell>
                <TableCell align="right" mono>{row.credit}</TableCell>
                <TableCell>
                  <Badge tone={statusTone[row.status]}>{row.status}</Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
