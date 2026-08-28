"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import CreateAdminForm from "./CreateAdminForm";

type AdminRow = { id: string; email: string; role: string; status: string; brokerName: string | null };
type BrokerOption = { id: string; name: string };

// No client component existed for this page at all before -- the Server
// Component rendered the admin table inline alongside CreateAdminForm
// (already a client component). Self-fetches from the already-existing
// /api/admin/admins GET (bare array, unchanged) and /api/admin/brokers
// GET (BrokersManager's own source, mapped down to id/name) instead of
// both being server-rendered props.
export default function AdminsManager() {
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [brokers, setBrokers] = useState<BrokerOption[] | null>(null);

  function reloadAdmins() {
    return fetch("/api/admin/admins")
      .then((r) => r.json())
      .then(setAdmins);
  }

  useEffect(() => {
    reloadAdmins().catch(() => setAdmins([]));
    fetch("/api/admin/brokers")
      .then((r) => r.json())
      .then((d: { rows: { id: string; name: string }[] }) => setBrokers(d.rows.map((b) => ({ id: b.id, name: b.name }))))
      .catch(() => setBrokers([]));
  }, []);

  if (admins === null || brokers === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Table>
        <TableHead>
          <TableHeaderCell>Email</TableHeaderCell>
          <TableHeaderCell>Broker</TableHeaderCell>
          <TableHeaderCell>Role</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableHead>
        <TableBody>
          {admins.length === 0 ? (
            <TableEmptyState colSpan={4}>No admins yet.</TableEmptyState>
          ) : (
            admins.map((admin) => (
              <TableRow key={admin.id}>
                <TableCell primary>{admin.email}</TableCell>
                <TableCell>{admin.brokerName ?? "—"}</TableCell>
                <TableCell>
                  <Badge tone="accent">{admin.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge tone={admin.status === "ACTIVE" ? "success" : "neutral"}>{admin.status}</Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <CreateAdminForm brokers={brokers} onCreated={reloadAdmins} />
    </div>
  );
}
