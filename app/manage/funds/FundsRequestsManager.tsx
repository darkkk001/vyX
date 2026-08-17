"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const mono: React.CSSProperties = { fontFamily: "monospace" };

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
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>
          <th align="left" style={th}>Account</th>
          <th align="left" style={th}>Type</th>
          <th align="right" style={th}>Amount</th>
          <th align="right" style={th}>Current balance</th>
          <th align="left" style={th}>Status</th>
          <th align="left" style={th}>Requested</th>
          <th style={th} />
        </tr>
      </thead>
      <tbody>
        {initialRows.length === 0 ? (
          <tr>
            <td colSpan={7} style={{ padding: "12px 8px", color: "#999" }}>No funds requests.</td>
          </tr>
        ) : (
          initialRows.map((row) => (
            <tr key={row.id}>
              <td style={td}>
                <span style={mono}>{row.accountNumber}</span>
                <div style={{ fontSize: 11, color: "#999" }}>{row.accountFullName}</div>
              </td>
              <td style={{ ...td, color: row.type === "DEPOSIT" ? "green" : "crimson" }}>{row.type}</td>
              <td align="right" style={{ ...td, ...mono }}>{row.amount}</td>
              <td align="right" style={{ ...td, ...mono }}>{row.currentBalance}</td>
              <td style={td}>{row.status}</td>
              <td style={{ ...td, fontSize: 11, color: "#999" }}>{row.createdAt}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                {row.status === "PENDING" ? (
                  <>
                    <button type="button" disabled={busyId === row.id} onClick={() => review(row, "APPROVE")}>
                      Approve
                    </button>{" "}
                    <button type="button" disabled={busyId === row.id} onClick={() => review(row, "REJECT")}>
                      Reject
                    </button>
                    {errors[row.id] ? <div style={{ color: "crimson", fontSize: 11 }}>{errors[row.id]}</div> : null}
                  </>
                ) : null}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
