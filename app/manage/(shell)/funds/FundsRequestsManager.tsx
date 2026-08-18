"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal, ModalActions } from "@/components/ui/Modal";
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
  const [confirmTarget, setConfirmTarget] = useState<{ row: FundsRequestRow; action: "APPROVE" | "REJECT" } | null>(null);

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
      setConfirmTarget(null);
      return;
    }
    setConfirmTarget(null);
    router.refresh();
  }

  return (
    <>
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
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.accountFullName}</div>
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
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.status === "PENDING" ? (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "APPROVE" })}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "REJECT" })}>
                        Reject
                      </Button>
                    </div>
                  ) : null}
                  {errors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{errors[row.id]}</div> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal
        open={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={confirmTarget ? `${confirmTarget.action === "APPROVE" ? "Approve" : "Reject"} ${confirmTarget.row.type.toLowerCase()}` : ""}
      >
        {confirmTarget ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              {confirmTarget.action === "APPROVE"
                ? `This moves ${confirmTarget.row.amount} through the ledger onto ${confirmTarget.row.accountNumber}'s balance.`
                : `${confirmTarget.row.accountNumber}'s balance is left untouched.`}
            </p>
            <ModalActions>
              <Button variant="ghost" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button
                variant={confirmTarget.action === "APPROVE" ? "success" : "danger"}
                disabled={busyId === confirmTarget.row.id}
                onClick={() => review(confirmTarget.row, confirmTarget.action)}
              >
                {busyId === confirmTarget.row.id ? "Working..." : `Confirm ${confirmTarget.action === "APPROVE" ? "approval" : "rejection"}`}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
