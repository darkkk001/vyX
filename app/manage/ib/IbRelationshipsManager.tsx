"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type IbRelationshipRow = {
  id: string;
  ibAccountId: string;
  ibAccountNumber: string;
  ibAccountFullName: string;
  clientAccountId: string;
  clientAccountNumber: string;
  clientAccountFullName: string;
  commissionType: "PER_LOT" | "PERCENTAGE";
  commissionRate: string;
  pendingCommission: string;
  lastPayoutAt: string | null;
};

export type AccountOption = { id: string; accountNumber: string; fullName: string };

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const mono: React.CSSProperties = { fontFamily: "monospace" };

// Create-form + editable table, same shape as every other Manager
// client component this session (useState per field, fetch+router.refresh
// on success, crimson/green inline-style feedback).
export default function IbRelationshipsManager({
  initialRows,
  ibOptions,
  clientOptions,
}: {
  initialRows: IbRelationshipRow[];
  ibOptions: AccountOption[];
  clientOptions: AccountOption[];
}) {
  const router = useRouter();

  // --- Create form ---
  const [ibAccountId, setIbAccountId] = useState(ibOptions[0]?.id ?? "");
  const [clientAccountId, setClientAccountId] = useState(clientOptions[0]?.id ?? "");
  const [commissionType, setCommissionType] = useState<"PER_LOT" | "PERCENTAGE">("PER_LOT");
  const [commissionRate, setCommissionRate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function createRelationship(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/ib-relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ibAccountId, clientAccountId, commissionType, commissionRate }),
    });
    setCreating(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create relationship");
      return;
    }
    setCommissionRate("");
    router.refresh();
  }

  // --- Per-row rate/type edit ---
  const [draftType, setDraftType] = useState<Record<string, "PER_LOT" | "PERCENTAGE">>({});
  const [draftRate, setDraftRate] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  async function saveEdit(row: IbRelationshipRow) {
    setSavingId(row.id);
    setSavedId(null);
    setEditErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/ib-relationships/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commissionType: draftType[row.id] ?? row.commissionType,
        commissionRate: draftRate[row.id] ?? row.commissionRate,
      }),
    });
    setSavingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setEditErrors((prev) => ({ ...prev, [row.id]: body.error ?? "save failed" }));
      return;
    }
    setSavedId(row.id);
    router.refresh();
  }

  // --- Pay action ---
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payErrors, setPayErrors] = useState<Record<string, string>>({});

  async function pay(row: IbRelationshipRow) {
    setPayingId(row.id);
    setPayErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/ib-relationships/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "PAY" }),
    });
    setPayingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setPayErrors((prev) => ({ ...prev, [row.id]: body.error ?? "payout failed" }));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <h2>Add a relationship</h2>
      <form
        onSubmit={createRelationship}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "2rem" }}
      >
        <select value={ibAccountId} onChange={(e) => setIbAccountId(e.target.value)} required>
          {ibOptions.map((a) => (
            <option key={a.id} value={a.id}>
              IB: {a.accountNumber} — {a.fullName}
            </option>
          ))}
        </select>
        <select value={clientAccountId} onChange={(e) => setClientAccountId(e.target.value)} required>
          {clientOptions.length === 0 ? (
            <option value="">— no unlinked accounts —</option>
          ) : (
            clientOptions.map((a) => (
              <option key={a.id} value={a.id}>
                Client: {a.accountNumber} — {a.fullName}
              </option>
            ))
          )}
        </select>
        <select value={commissionType} onChange={(e) => setCommissionType(e.target.value as "PER_LOT" | "PERCENTAGE")}>
          <option value="PER_LOT">Per lot ($)</option>
          <option value="PERCENTAGE">Percentage (%)</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={commissionRate}
          onChange={(e) => setCommissionRate(e.target.value)}
          placeholder="Rate"
          style={{ width: 80, ...mono }}
          required
        />
        <button type="submit" disabled={creating || !ibAccountId || !clientAccountId}>
          {creating ? "Adding..." : "Add"}
        </button>
        {createError ? <span style={{ color: "crimson" }}>{createError}</span> : null}
      </form>

      <h2>Relationships</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={th}>IB</th>
            <th align="left" style={th}>Client</th>
            <th align="left" style={th}>Type</th>
            <th align="right" style={th}>Rate</th>
            <th align="right" style={th}>Pending</th>
            <th align="left" style={th}>Last payout</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {initialRows.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ padding: "12px 8px", color: "#999" }}>No IB relationships.</td>
            </tr>
          ) : (
            initialRows.map((row) => (
              <tr key={row.id}>
                <td style={td}>
                  {row.ibAccountNumber}
                  <div style={{ fontSize: 11, color: "#999" }}>{row.ibAccountFullName}</div>
                </td>
                <td style={td}>
                  {row.clientAccountNumber}
                  <div style={{ fontSize: 11, color: "#999" }}>{row.clientAccountFullName}</div>
                </td>
                <td style={td}>
                  <select
                    value={draftType[row.id] ?? row.commissionType}
                    onChange={(e) => setDraftType((prev) => ({ ...prev, [row.id]: e.target.value as "PER_LOT" | "PERCENTAGE" }))}
                  >
                    <option value="PER_LOT">Per lot ($)</option>
                    <option value="PERCENTAGE">Percentage (%)</option>
                  </select>
                </td>
                <td align="right" style={td}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={draftRate[row.id] ?? row.commissionRate}
                    onChange={(e) => setDraftRate((prev) => ({ ...prev, [row.id]: e.target.value }))}
                    style={{ width: 70, ...mono }}
                  />
                </td>
                <td align="right" style={{ ...td, ...mono }}>{row.pendingCommission}</td>
                <td style={{ ...td, fontSize: 11, color: "#999" }}>{row.lastPayoutAt ?? "never"}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button type="button" disabled={savingId === row.id} onClick={() => saveEdit(row)}>
                    {savingId === row.id ? "Saving..." : "Save"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={payingId === row.id || Number(row.pendingCommission) <= 0}
                    onClick={() => pay(row)}
                  >
                    {payingId === row.id ? "Paying..." : "Pay"}
                  </button>
                  {savedId === row.id ? <span style={{ color: "green", marginLeft: 6 }}>Saved</span> : null}
                  {editErrors[row.id] ? <div style={{ color: "crimson", fontSize: 11 }}>{editErrors[row.id]}</div> : null}
                  {payErrors[row.id] ? <div style={{ color: "crimson", fontSize: 11 }}>{payErrors[row.id]}</div> : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
