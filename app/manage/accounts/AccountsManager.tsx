"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";

export type AccountRow = {
  id: string;
  accountNumber: string;
  fullName: string;
  email: string;
  accountType: string;
  currency: string;
  leverage: number;
  balance: string;
  credit: string;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  groupId: string | null;
  groupName: string | null;
};

export type GroupOption = { id: string; name: string };

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const mono: React.CSSProperties = { fontFamily: "monospace" };

// Group reassignment is available to both MANAGER and BROKER_ADMIN
// (matches app/api/manage/accounts/[id]/route.ts's per-field permission
// check); leverage/status/balance-adjustment only render at all when
// `canManageFinance` (BROKER_ADMIN) -- per AdminRole.MANAGER's own schema
// comment, these are finance-adjacent, not dealing-desk config.
export default function AccountsManager({
  initialRows,
  groups,
  canManageFinance,
}: {
  initialRows: AccountRow[];
  groups: GroupOption[];
  canManageFinance: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<AccountRow[]>(initialRows);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adjustOpenId, setAdjustOpenId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.accountNumber.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
  });

  async function patchAccount(id: string, body: Record<string, unknown>) {
    setBusyId(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [id]: b.error ?? "update failed" }));
      return false;
    }
    router.refresh();
    return true;
  }

  async function changeGroup(row: AccountRow, groupId: string) {
    await patchAccount(row.id, { groupId: groupId || null });
  }

  async function changeStatus(row: AccountRow, status: string) {
    await patchAccount(row.id, { status });
  }

  async function changeLeverage(row: AccountRow, leverage: string) {
    const n = Number(leverage);
    if (!Number.isFinite(n) || n <= 0) return;
    await patchAccount(row.id, { leverage: n });
  }

  async function submitAdjustment(row: AccountRow) {
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/accounts/${row.id}/adjust-balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: adjustAmount, note: adjustNote }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: b.error ?? "adjustment failed" }));
      return;
    }
    setAdjustOpenId(null);
    setAdjustAmount("");
    setAdjustNote("");
    router.refresh();
  }

  return (
    <>
      <input
        type="text"
        placeholder="Search by account number, name, or email..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: 320, padding: "6px 8px", marginBottom: 12 }}
      />
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={th}>Account</th>
            <th align="left" style={th}>Type</th>
            <th align="left" style={th}>Group</th>
            <th align="right" style={th}>Leverage</th>
            <th align="right" style={th}>Balance</th>
            <th align="right" style={th}>Credit</th>
            <th align="left" style={th}>Status</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={8} style={{ padding: "12px 8px", color: "#999" }}>No accounts match.</td>
            </tr>
          ) : (
            filtered.map((row) => (
              <Fragment key={row.id}>
                <tr>
                  <td style={td}>
                    <span style={mono}>{row.accountNumber}</span>
                    <div style={{ fontSize: 11, color: "#999" }}>{row.fullName} — {row.email}</div>
                  </td>
                  <td style={td}>{row.accountType}</td>
                  <td style={td}>
                    <select
                      value={row.groupId ?? ""}
                      disabled={busyId === row.id}
                      onChange={(e) => changeGroup(row, e.target.value)}
                    >
                      <option value="">— ungrouped —</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </td>
                  <td align="right" style={{ ...td, ...mono }}>
                    {canManageFinance ? (
                      <input
                        type="text"
                        inputMode="numeric"
                        defaultValue={row.leverage}
                        disabled={busyId === row.id}
                        onBlur={(e) => e.target.value !== String(row.leverage) && changeLeverage(row, e.target.value)}
                        style={{ width: 60, ...mono }}
                      />
                    ) : (
                      row.leverage
                    )}
                  </td>
                  <td align="right" style={{ ...td, ...mono }}>{row.balance}</td>
                  <td align="right" style={{ ...td, ...mono }}>{row.credit}</td>
                  <td style={td}>
                    {canManageFinance ? (
                      <select value={row.status} disabled={busyId === row.id} onChange={(e) => changeStatus(row, e.target.value)}>
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                        <option value="CLOSED">CLOSED</option>
                      </select>
                    ) : (
                      row.status
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {canManageFinance ? (
                      <button type="button" onClick={() => setAdjustOpenId(adjustOpenId === row.id ? null : row.id)}>
                        Adjust balance
                      </button>
                    ) : null}
                    {errors[row.id] ? <div style={{ color: "crimson", fontSize: 11 }}>{errors[row.id]}</div> : null}
                  </td>
                </tr>
                {adjustOpenId === row.id ? (
                  <tr>
                    <td colSpan={8} style={{ ...td, background: "#fafafa" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Amount (+/-)"
                          value={adjustAmount}
                          onChange={(e) => setAdjustAmount(e.target.value)}
                          style={{ width: 100, ...mono }}
                        />
                        <input
                          type="text"
                          placeholder="Reason (required)"
                          value={adjustNote}
                          onChange={(e) => setAdjustNote(e.target.value)}
                          style={{ width: 280 }}
                        />
                        <button type="button" disabled={busyId === row.id} onClick={() => submitAdjustment(row)}>
                          {busyId === row.id ? "Submitting..." : "Submit"}
                        </button>
                        <button type="button" onClick={() => setAdjustOpenId(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
