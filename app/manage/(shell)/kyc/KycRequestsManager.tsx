"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type KycRequestRow = {
  id: string;
  status: string;
  documentType: string;
  rejectionReason: string | null;
  accountNumber: string;
  accountFullName: string;
  createdAt: string;
};

const statusTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

export default function KycRequestsManager({ initialRows }: { initialRows: KycRequestRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

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
    setRejectingId(null);
    setRejectReason("");
    router.refresh();
  }

  return (
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
        {initialRows.length === 0 ? (
          <TableEmptyState colSpan={6}>No KYC submissions.</TableEmptyState>
        ) : (
          initialRows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <span className="font-mono">{row.accountNumber}</span>
                <div className="text-xs text-slate-400">{row.accountFullName}</div>
              </TableCell>
              <TableCell>{row.documentType}</TableCell>
              <TableCell>
                <a
                  href={`/api/manage/kyc-requests/${row.id}/document?side=front`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-600 hover:underline"
                >
                  Front
                </a>{" "}
                <span className="text-slate-300">|</span>{" "}
                <a
                  href={`/api/manage/kyc-requests/${row.id}/document?side=back`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-600 hover:underline"
                >
                  Back
                </a>
              </TableCell>
              <TableCell>
                <Badge tone={statusTone[row.status as keyof typeof statusTone] ?? "neutral"}>{row.status}</Badge>
                {row.status === "REJECTED" && row.rejectionReason ? (
                  <div className="mt-0.5 text-xs text-slate-400">{row.rejectionReason}</div>
                ) : null}
              </TableCell>
              <TableCell className="text-xs text-slate-400">{row.createdAt}</TableCell>
              <TableCell className="whitespace-nowrap">
                {row.status === "PENDING" ? (
                  rejectingId === row.id ? (
                    <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">
                      <Input
                        type="text"
                        placeholder="Reason"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="w-36 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === row.id || !rejectReason.trim()}
                        onClick={() => review(row.id, "REJECT", rejectReason.trim())}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRejectingId(null);
                          setRejectReason("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="primary" disabled={busyId === row.id} onClick={() => review(row.id, "APPROVE")}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => setRejectingId(row.id)}>
                        Reject
                      </Button>
                    </div>
                  )
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
