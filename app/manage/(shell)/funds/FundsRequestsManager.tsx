"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type FundsRequestRow = {
  id: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  status: string;
  amount: string;
  note: string | null;
  accountNumber: string;
  accountFullName: string;
  currentBalance: string;
  createdAt: string;
};

const statusTone = { PENDING: "warning", COMPLETED: "success", REJECTED: "danger" } as const;

export default function FundsRequestsManager({ initialRows }: { initialRows: FundsRequestRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function review(row: FundsRequestRow, action: "APPROVE" | "REJECT") {
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/funds-requests/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusyId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: body.error ?? `${action.toLowerCase()} failed` }));
      return;
    }
    router.refresh();
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Account</TableHeaderCell>
        <TableHeaderCell>Type</TableHeaderCell>
        <TableHeaderCell align="right">Amount</TableHeaderCell>
        <TableHeaderCell align="right">Current balance</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
        <TableHeaderCell>Requested</TableHeaderCell>
        <TableHeaderCell />
      </TableHead>
      <TableBody>
        {initialRows.length === 0 ? (
          <TableEmptyState colSpan={7}>No funds requests.</TableEmptyState>
        ) : (
          initialRows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <span className="font-mono">{row.accountNumber}</span>
                <div className="text-xs text-slate-400">{row.accountFullName}</div>
              </TableCell>
              <TableCell>
                <Badge tone={row.type === "DEPOSIT" ? "success" : "danger"}>{row.type}</Badge>
              </TableCell>
              <TableCell align="right" mono>
                {row.amount}
              </TableCell>
              <TableCell align="right" mono>
                {row.currentBalance}
              </TableCell>
              <TableCell>
                <Badge tone={statusTone[row.status as keyof typeof statusTone] ?? "neutral"}>{row.status}</Badge>
              </TableCell>
              <TableCell className="text-xs text-slate-400">{row.createdAt}</TableCell>
              <TableCell className="whitespace-nowrap">
                {row.status === "PENDING" ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="primary" disabled={busyId === row.id} onClick={() => review(row, "APPROVE")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => review(row, "REJECT")}>
                      Reject
                    </Button>
                  </div>
                ) : null}
                {errors[row.id] ? <div className="mt-1 text-xs text-rose-600">{errors[row.id]}</div> : null}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
