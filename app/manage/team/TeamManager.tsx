"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AdminRow = {
  id: string;
  email: string;
  // Broker-scoped AdminUsers are always one of these three -- SUPER_ADMIN
  // always has brokerId null, so it can never appear in a
  // where: { brokerId } query result, even though AdminRole itself has a
  // fourth member.
  role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT";
  status: "ACTIVE" | "DISABLED";
  lastLoginAt: string | null;
};

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };

export default function TeamManager({ initialRows, currentAdminId }: { initialRows: AdminRow[]; currentAdminId: string }) {
  const router = useRouter();

  // --- Create form ---
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"BROKER_ADMIN" | "MANAGER" | "SUPPORT">("MANAGER");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function createAdmin(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role }),
    });
    setCreating(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create admin");
      return;
    }
    setEmail("");
    setPassword("");
    router.refresh();
  }

  // --- Status toggle, per row ---
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function changeStatus(row: AdminRow, status: "ACTIVE" | "DISABLED") {
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/admins/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: body.error ?? "update failed" }));
      return;
    }
    router.refresh();
  }

  return (
    <>
      <h2>Add a team member</h2>
      <form
        onSubmit={createAdmin}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "2rem" }}
      >
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Initial password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as "BROKER_ADMIN" | "MANAGER" | "SUPPORT")}>
          <option value="BROKER_ADMIN">Broker Admin</option>
          <option value="MANAGER">Manager</option>
          <option value="SUPPORT">Support</option>
        </select>
        <button type="submit" disabled={creating}>
          {creating ? "Adding..." : "Add"}
        </button>
        {createError ? <span style={{ color: "crimson" }}>{createError}</span> : null}
      </form>

      <h2>Team</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={th}>Email</th>
            <th align="left" style={th}>Role</th>
            <th align="left" style={th}>Status</th>
            <th align="left" style={th}>Last login</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {initialRows.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ padding: "12px 8px", color: "#999" }}>No team members.</td>
            </tr>
          ) : (
            initialRows.map((row) => {
              const isSelf = row.id === currentAdminId;
              return (
                <tr key={row.id}>
                  <td style={td}>
                    {row.email}
                    {isSelf ? <span style={{ fontSize: 11, color: "#999" }}> (you)</span> : null}
                  </td>
                  <td style={td}>{row.role}</td>
                  <td style={td}>
                    <select
                      value={row.status}
                      disabled={busyId === row.id || isSelf}
                      title={isSelf ? "You cannot change your own status" : undefined}
                      onChange={(e) => changeStatus(row, e.target.value as "ACTIVE" | "DISABLED")}
                    >
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="DISABLED">DISABLED</option>
                    </select>
                  </td>
                  <td style={{ ...td, fontSize: 11, color: "#999" }}>{row.lastLoginAt ?? "never"}</td>
                  <td style={td}>
                    {errors[row.id] ? <span style={{ color: "crimson", fontSize: 11 }}>{errors[row.id]}</span> : null}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </>
  );
}
