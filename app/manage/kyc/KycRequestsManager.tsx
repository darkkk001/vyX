"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type KycRequestRow = {
  id: string;
  status: string;
  documentType: string;
  rejectionReason: string | null;
  accountNumber: string;
  accountFullName: string;
  createdAt: string;
};

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const mono: React.CSSProperties = { fontFamily: "monospace" };

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
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>
          <th align="left" style={th}>Account</th>
          <th align="left" style={th}>Document type</th>
          <th align="left" style={th}>Documents</th>
          <th align="left" style={th}>Status</th>
          <th align="left" style={th}>Submitted</th>
          <th style={th} />
        </tr>
      </thead>
      <tbody>
        {initialRows.length === 0 ? (
          <tr>
            <td colSpan={6} style={{ padding: "12px 8px", color: "#999" }}>No KYC submissions.</td>
          </tr>
        ) : (
          initialRows.map((row) => (
            <tr key={row.id}>
              <td style={td}>
                <span style={mono}>{row.accountNumber}</span>
                <div style={{ fontSize: 11, color: "#999" }}>{row.accountFullName}</div>
              </td>
              <td style={td}>{row.documentType}</td>
              <td style={td}>
                <a href={`/api/manage/kyc-requests/${row.id}/document?side=front`} target="_blank" rel="noreferrer">
                  Front
                </a>{" "}
                |{" "}
                <a href={`/api/manage/kyc-requests/${row.id}/document?side=back`} target="_blank" rel="noreferrer">
                  Back
                </a>
              </td>
              <td style={td}>
                {row.status}
                {row.status === "REJECTED" && row.rejectionReason ? (
                  <div style={{ fontSize: 11, color: "#999" }}>{row.rejectionReason}</div>
                ) : null}
              </td>
              <td style={{ ...td, fontSize: 11, color: "#999" }}>{row.createdAt}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                {row.status === "PENDING" ? (
                  rejectingId === row.id ? (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input
                        type="text"
                        placeholder="Reason"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        style={{ width: 140, fontSize: 12 }}
                      />
                      <button
                        type="button"
                        disabled={busyId === row.id || !rejectReason.trim()}
                        onClick={() => review(row.id, "REJECT", rejectReason.trim())}
                      >
                        Confirm
                      </button>
                      <button type="button" onClick={() => { setRejectingId(null); setRejectReason(""); }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button type="button" disabled={busyId === row.id} onClick={() => review(row.id, "APPROVE")}>
                        Approve
                      </button>{" "}
                      <button type="button" disabled={busyId === row.id} onClick={() => setRejectingId(row.id)}>
                        Reject
                      </button>
                    </>
                  )
                ) : null}
                {errors[row.id] ? <div style={{ color: "crimson", fontSize: 11 }}>{errors[row.id]}</div> : null}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
