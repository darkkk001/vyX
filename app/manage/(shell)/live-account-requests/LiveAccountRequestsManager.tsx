"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type LiveAccountRequestRow = {
  id: string;
  status: string;
  rejectionReason: string | null;
  accountTypeName: string | null;
  createdAccountNumber: string | null;
  clientFullName: string;
  clientEmail: string;
  clientCountry: string | null;
  clientPhone: string | null;
  createdAt: string;
};

const statusTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

// Same self-fetch/review pattern as the KYC managers (app/manage/(shell)/
// kyc, client-kyc) -- approving here actually creates the real Account
// (see the PATCH route's own comment), so the row shows the resulting
// account number once that's done rather than needing a second lookup.
export default function LiveAccountRequestsManager() {
  const [rows, setRows] = useState<LiveAccountRequestRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejectTarget, setRejectTarget] = useState<LiveAccountRequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function load() {
    return fetch("/api/manage/live-account-requests")
      .then((r) => r.json())
      .then((d: LiveAccountRequestRow[]) => setRows(d.map((r) => ({ ...r, createdAt: formatDateTime(r.createdAt) }))));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function review(id: string, action: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/live-account-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, rejectionReason }),
    });
    setBusyId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [id]: body.error ?? `${action.toLowerCase()} failed` }));
      return;
    }
    setRejectTarget(null);
    setRejectReason("");
    load().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <>
      <Table>
        <TableHead>
          <TableHeaderCell>Client</TableHeaderCell>
          <TableHeaderCell>Account type</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Requested</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmptyState colSpan={5}>No Live account requests.</TableEmptyState>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  {row.clientFullName}
                  <div className="text-xs font-normal text-[var(--text-3)]">
                    {row.clientEmail}
                    {row.clientCountry ? `, ${row.clientCountry}` : ""}
                    {row.clientPhone ? `, ${row.clientPhone}` : ""}
                  </div>
                </TableCell>
                <TableCell>{row.accountTypeName ?? "-"}</TableCell>
                <TableCell>
                  <Badge tone={statusTone[row.status as keyof typeof statusTone] ?? "neutral"}>{row.status}</Badge>
                  {row.status === "REJECTED" && row.rejectionReason ? (
                    <div className="mt-0.5 text-xs text-[var(--text-3)]">{row.rejectionReason}</div>
                  ) : null}
                  {row.status === "APPROVED" && row.createdAccountNumber ? (
                    <div className="mt-0.5 font-mono text-xs text-[var(--text-3)]">{row.createdAccountNumber}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.status === "PENDING" ? (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => review(row.id, "APPROVE")}>
                        {busyId === row.id ? "Approving..." : "Approve"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === row.id}
                        onClick={() => {
                          setRejectTarget(row);
                          setRejectReason("");
                        }}
                      >
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

      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={`Reject Live account request - ${rejectTarget?.clientFullName ?? ""}`}>
        <div className="flex flex-col gap-3">
          <FormField label="Reason (required, shown to the client)">
            <Input type="text" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. KYC needs to be resubmitted" />
          </FormField>
          {rejectTarget && errors[rejectTarget.id] ? <p className="text-sm text-[var(--sell)]">{errors[rejectTarget.id]}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!rejectReason.trim() || busyId === rejectTarget?.id}
              onClick={() => rejectTarget && review(rejectTarget.id, "REJECT", rejectReason.trim())}
            >
              {busyId === rejectTarget?.id ? "Rejecting..." : "Reject request"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </>
  );
}
