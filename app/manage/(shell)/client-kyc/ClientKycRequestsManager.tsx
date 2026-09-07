"use client";

import { Fragment, useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type ClientKycRequestRow = {
  id: string;
  status: string;
  documentType: string;
  rejectionReason: string | null;
  hasAddressProof: boolean;
  annualIncome: string | null;
  sourceOfFunds: string | null;
  tradingExperience: string | null;
  employmentStatus: string | null;
  riskTolerance: string | null;
  clientFullName: string;
  clientEmail: string;
  clientCountry: string | null;
  clientPhone: string | null;
  createdAt: string;
};

const statusTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

// Client-level counterpart to app/manage/(shell)/kyc/KycRequestsManager.tsx
// -- same self-fetch/review pattern, pointed at
// /api/manage/client-kyc-requests, plus the suitability questionnaire
// answers that model doesn't have.
export default function ClientKycRequestsManager() {
  const [rows, setRows] = useState<ClientKycRequestRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejectTarget, setRejectTarget] = useState<ClientKycRequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function load() {
    return fetch("/api/manage/client-kyc-requests")
      .then((r) => r.json())
      .then((d: ClientKycRequestRow[]) => setRows(d.map((r) => ({ ...r, createdAt: formatDateTime(r.createdAt) }))));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function review(id: string, action: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/client-kyc-requests/${id}`, {
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
          <TableHeaderCell>Document type</TableHeaderCell>
          <TableHeaderCell>Documents</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Submitted</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmptyState colSpan={6}>No client KYC submissions.</TableEmptyState>
          ) : (
            rows.map((row) => (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell primary>
                    {row.clientFullName}
                    <div className="text-xs font-normal text-[var(--text-3)]">
                      {row.clientEmail}
                      {row.clientCountry ? `, ${row.clientCountry}` : ""}
                      {row.clientPhone ? `, ${row.clientPhone}` : ""}
                    </div>
                  </TableCell>
                  <TableCell>{row.documentType}</TableCell>
                  <TableCell>
                    <a href={`/api/manage/client-kyc-requests/${row.id}/document?side=front`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                      Front
                    </a>{" "}
                    <span className="text-[var(--border-strong)]">|</span>{" "}
                    <a href={`/api/manage/client-kyc-requests/${row.id}/document?side=back`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                      Back
                    </a>
                    {row.hasAddressProof ? (
                      <>
                        {" "}
                        <span className="text-[var(--border-strong)]">|</span>{" "}
                        <a href={`/api/manage/client-kyc-requests/${row.id}/document?side=address`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                          Address
                        </a>
                      </>
                    ) : null}
                    <div className="mt-1">
                      <button type="button" className="text-xs text-[var(--text-3)] hover:underline" onClick={() => setExpandedId((prev) => (prev === row.id ? null : row.id))}>
                        {expandedId === row.id ? "Hide suitability" : "View suitability"}
                      </button>
                    </div>
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
                {expandedId === row.id ? (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-[var(--bg-2)]">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-2 py-1 text-xs sm:grid-cols-3 lg:grid-cols-5">
                        <div>
                          <div className="text-[var(--text-3)]">Annual income</div>
                          <div>{row.annualIncome ?? "-"}</div>
                        </div>
                        <div>
                          <div className="text-[var(--text-3)]">Source of funds</div>
                          <div>{row.sourceOfFunds ?? "-"}</div>
                        </div>
                        <div>
                          <div className="text-[var(--text-3)]">Trading experience</div>
                          <div>{row.tradingExperience ?? "-"}</div>
                        </div>
                        <div>
                          <div className="text-[var(--text-3)]">Employment status</div>
                          <div>{row.employmentStatus ?? "-"}</div>
                        </div>
                        <div>
                          <div className="text-[var(--text-3)]">Risk tolerance</div>
                          <div>{row.riskTolerance ?? "-"}</div>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={`Reject KYC - ${rejectTarget?.clientFullName ?? ""}`}>
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
