"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type KycRequestRow = {
  id: string;
  status: string;
  documentType: string;
  rejectionReason: string | null;
  accountNumber: string;
  accountFullName: string;
  accountCountry: string | null;
  accountPhone: string | null;
  createdAt: string;
};

const statusTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

// Self-fetches from /api/manage/kyc-requests (extended to also return
// accountCountry/accountPhone, matching page.tsx's previous query
// exactly) instead of receiving rows as a server-rendered prop -- both
// the website and a bundled manager-shell desktop app (no Server
// Component of its own) share this one path now.
export default function KycRequestsManager() {
  const [rows, setRows] = useState<KycRequestRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejectTarget, setRejectTarget] = useState<KycRequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function load() {
    return fetch("/api/manage/kyc-requests")
      .then((r) => r.json())
      .then((d: KycRequestRow[]) => setRows(d.map((r) => ({ ...r, createdAt: formatDateTime(r.createdAt) }))));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function review(id: string, action: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/kyc-requests/${id}`, {
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
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Document type</TableHeaderCell>
          <TableHeaderCell>Documents</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Submitted</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmptyState colSpan={6}>No KYC submissions.</TableEmptyState>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">
                    {row.accountFullName}
                    {row.accountCountry ? ` — ${row.accountCountry}` : ""}
                    {row.accountPhone ? ` — ${row.accountPhone}` : ""}
                  </div>
                </TableCell>
                <TableCell>{row.documentType}</TableCell>
                <TableCell>
                  <a
                    href={`/api/manage/kyc-requests/${row.id}/document?side=front`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    Front
                  </a>{" "}
                  <span className="text-[var(--border-strong)]">|</span>{" "}
                  <a
                    href={`/api/manage/kyc-requests/${row.id}/document?side=back`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    Back
                  </a>
                </TableCell>
                <TableCell>
                  <Badge tone={statusTone[row.status as keyof typeof statusTone] ?? "neutral"}>{row.status}</Badge>
                  {row.status === "REJECTED" && row.rejectionReason ? (
                    <div className="mt-0.5 text-xs text-[var(--text-3)]">{row.rejectionReason}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.status === "PENDING" ? (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => review(row.id, "APPROVE")}>
                        Approve
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

      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={`Reject KYC — ${rejectTarget?.accountNumber ?? ""}`}>
        <div className="flex flex-col gap-3">
          <FormField label="Reason (required, shown to the client)">
            <Input type="text" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Photo is blurry, please resubmit" />
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
              {busyId === rejectTarget?.id ? "Rejecting..." : "Reject submission"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </>
  );
}
