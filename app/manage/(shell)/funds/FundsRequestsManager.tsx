"use client";

import { useEffect, useState } from "react";
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
  markedByAdminId: string | null;
  markedByAdminEmail: string | null;
  createdAt: string;
};

const statusTone = { PENDING: "warning", COMPLETED: "success", REJECTED: "danger" } as const;

// Self-fetches from /api/manage/funds-requests (extended to also return
// currentAdminId + markedByAdminId/markedByAdminEmail, matching
// page.tsx's previous query exactly) instead of receiving both as
// server-rendered props -- both the website and a bundled manager-shell
// desktop app (no Server Component of its own) share this one path now.
export default function FundsRequestsManager() {
  const [rows, setRows] = useState<FundsRequestRow[] | null>(null);
  const [currentAdminId, setCurrentAdminId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmTarget, setConfirmTarget] = useState<{ row: FundsRequestRow; action: "APPROVE" | "REJECT" | "CANCEL_MARK" } | null>(null);

  function load() {
    return fetch("/api/manage/funds-requests")
      .then((r) => r.json())
      .then((d: { currentAdminId: string; rows: FundsRequestRow[] }) => {
        setCurrentAdminId(d.currentAdminId);
        setRows(d.rows.map((r) => ({ ...r, createdAt: r.createdAt.replace("T", " ").slice(0, 19) })));
      });
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function review(row: FundsRequestRow, action: "APPROVE" | "REJECT" | "CANCEL_MARK") {
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
    load().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
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
          {rows.length === 0 ? (
            <TableEmptyState colSpan={7}>No funds requests.</TableEmptyState>
          ) : (
            rows.map((row) => (
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
                  {row.markedByAdminId ? (
                    <div className="mt-0.5 text-xs text-[var(--warn)]">
                      Marked by {row.markedByAdminEmail ?? "another staff member"} — needs 2nd approval
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.status === "PENDING" ? (
                    row.markedByAdminId === currentAdminId ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-[var(--text-3)]">Awaiting another staff member</span>
                        <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "CANCEL_MARK" })}>
                          Cancel mark
                        </Button>
                      </div>
                    ) : row.markedByAdminId ? (
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "APPROVE" })}>
                          Confirm (2nd approval)
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "REJECT" })}>
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "APPROVE" })}>
                          {row.type === "WITHDRAWAL" ? "Mark for approval" : "Approve"}
                        </Button>
                        <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => setConfirmTarget({ row, action: "REJECT" })}>
                          Reject
                        </Button>
                      </div>
                    )
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
        title={
          confirmTarget
            ? confirmTarget.action === "APPROVE"
              ? confirmTarget.row.type === "WITHDRAWAL" && !confirmTarget.row.markedByAdminId
                ? "Mark withdrawal for approval"
                : `Approve ${confirmTarget.row.type.toLowerCase()}`
              : confirmTarget.action === "CANCEL_MARK"
                ? "Cancel withdrawal mark"
                : `Reject ${confirmTarget.row.type.toLowerCase()}`
            : ""
        }
      >
        {confirmTarget ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              {confirmTarget.action === "CANCEL_MARK"
                ? "This request goes back to plain pending — either staff member can mark it again."
                : confirmTarget.action === "APPROVE"
                  ? confirmTarget.row.type === "WITHDRAWAL" && !confirmTarget.row.markedByAdminId
                    ? "This only marks the request -- a different staff member must confirm before any balance moves."
                    : `This moves ${confirmTarget.row.amount} through the ledger onto ${confirmTarget.row.accountNumber}'s balance.`
                  : `${confirmTarget.row.accountNumber}'s balance is left untouched.`}
            </p>
            <ModalActions>
              <Button variant="ghost" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button
                variant={confirmTarget.action === "APPROVE" ? "success" : confirmTarget.action === "CANCEL_MARK" ? "ghost" : "danger"}
                disabled={busyId === confirmTarget.row.id}
                onClick={() => review(confirmTarget.row, confirmTarget.action)}
              >
                {busyId === confirmTarget.row.id
                  ? "Working..."
                  : confirmTarget.action === "CANCEL_MARK"
                    ? "Confirm cancel"
                    : `Confirm ${confirmTarget.action === "APPROVE" ? "approval" : "rejection"}`}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
