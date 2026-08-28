"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { PERMISSIONS, PERMISSION_LABELS, type Permission } from "@/lib/permission-labels";

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
  // Only meaningful for role === "MANAGER" -- see lib/permissions.ts.
  extraPermissions: string[];
};

// Self-fetches from /api/manage/admins (extended to also return
// extraPermissions + currentAdminId, matching page.tsx's previous query
// exactly) instead of receiving both as server-rendered props -- both
// the website and a bundled manager-shell desktop app (no Server
// Component of its own) share this one path now.
export default function TeamManager() {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [currentAdminId, setCurrentAdminId] = useState<string | null>(null);

  function load() {
    return fetch("/api/manage/admins")
      .then((r) => r.json())
      .then((d: { currentAdminId: string; rows: AdminRow[] }) => {
        setCurrentAdminId(d.currentAdminId);
        setRows(d.rows.map((r) => ({ ...r, lastLoginAt: r.lastLoginAt ? r.lastLoginAt.replace("T", " ").slice(0, 19) : null })));
      });
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

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
    load().catch(() => {});
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
    load().catch(() => {});
  }

  // --- Delegated permissions, per MANAGER row ---
  async function togglePermission(row: AdminRow, permission: Permission) {
    const next = row.extraPermissions.includes(permission)
      ? row.extraPermissions.filter((p) => p !== permission)
      : [...row.extraPermissions, permission];
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/admins/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraPermissions: next }),
    });
    setBusyId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: body.error ?? "update failed" }));
      return;
    }
    load().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-[var(--text-3)]">
        {rows.length} admin{rows.length === 1 ? "" : "s"} for this broker.
      </p>
      <Card title="Add a team member">
        <form onSubmit={createAdmin} className="flex flex-wrap items-center gap-2">
          <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-48" />
          <Input
            type="password"
            placeholder="Initial password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-56"
          />
          <Select value={role} onChange={(e) => setRole(e.target.value as "BROKER_ADMIN" | "MANAGER" | "SUPPORT")} className="w-40">
            <option value="BROKER_ADMIN">Broker Admin</option>
            <option value="MANAGER">Manager</option>
            <option value="SUPPORT">Support</option>
          </Select>
          <Button type="submit" variant="primary" disabled={creating}>
            {creating ? "Adding..." : "Add"}
          </Button>
          {createError ? <span className="text-sm text-[var(--sell)]">{createError}</span> : null}
        </form>
      </Card>

      <Card title="Team">
        <Table>
          <TableHead>
            <TableHeaderCell className="min-w-[200px]">Email</TableHeaderCell>
            <TableHeaderCell className="min-w-[110px]">Role</TableHeaderCell>
            <TableHeaderCell className="min-w-[150px]">Status</TableHeaderCell>
            <TableHeaderCell className="min-w-[200px]" title="Only applies to Manager-role staff -- Broker Admin already has everything">
              Delegated permissions
            </TableHeaderCell>
            <TableHeaderCell className="min-w-[150px]">Last login</TableHeaderCell>
            <TableHeaderCell className="min-w-[100px]" />
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={6}>No team members.</TableEmptyState>
            ) : (
              rows.map((row) => {
                const isSelf = row.id === currentAdminId;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="min-w-[200px]">
                      {row.email}
                      {isSelf ? <span className="text-xs text-[var(--text-3)]"> (you)</span> : null}
                    </TableCell>
                    <TableCell className="min-w-[110px]">
                      <Badge tone="accent">{row.role}</Badge>
                    </TableCell>
                    <TableCell className="min-w-[150px]">
                      <Select
                        value={row.status}
                        disabled={busyId === row.id || isSelf}
                        title={isSelf ? "You cannot change your own status" : undefined}
                        onChange={(e) => changeStatus(row, e.target.value as "ACTIVE" | "DISABLED")}
                        className="w-full"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="DISABLED">DISABLED</option>
                      </Select>
                    </TableCell>
                    <TableCell className="min-w-[200px]">
                      {row.role === "MANAGER" ? (
                        <div className="flex flex-col gap-1">
                          {PERMISSIONS.map((p) => (
                            <Checkbox
                              key={p}
                              label={PERMISSION_LABELS[p]}
                              checked={row.extraPermissions.includes(p)}
                              disabled={busyId === row.id}
                              onChange={() => togglePermission(row, p)}
                              className="h-3.5 w-3.5"
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--text-3)]">{row.role === "BROKER_ADMIN" ? "has everything" : "n/a"}</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[150px] text-xs text-[var(--text-3)]">{row.lastLoginAt ?? "never"}</TableCell>
                    <TableCell className="min-w-[100px]">
                      {errors[row.id] ? <span className="text-xs text-[var(--sell)]">{errors[row.id]}</span> : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
