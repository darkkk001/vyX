"use client";

import { useEffect, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type AuditLogRow = {
  id: string;
  actorEmail: string;
  actionLabel: string;
  brokerName: string | null;
  createdAtLabel: string;
};

// Self-fetches from /api/admin/audit on mount -- was rendered inline in
// the Server Component before (app/(super-admin)/(shell)/audit/page.tsx
// had no client component at all), extracted here so both the website
// and a bundled admin-shell desktop app (which has no Server Component
// to pre-fetch this) can share one path, mirroring the equivalent
// Manager conversion (app/manage/(shell)/audit/AuditLogTable.tsx).
export default function AuditLogTable() {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);

  useEffect(() => {
    fetch("/api/admin/audit")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Actor</TableHeaderCell>
        <TableHeaderCell>Action</TableHeaderCell>
        <TableHeaderCell>Tenant</TableHeaderCell>
        <TableHeaderCell>Time</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={4}>No audit entries yet.</TableEmptyState>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell primary>{row.actorEmail}</TableCell>
              <TableCell>{row.actionLabel}</TableCell>
              <TableCell className="text-[var(--text-3)]">{row.brokerName ?? "—"}</TableCell>
              <TableCell className="text-xs text-[var(--text-3)]">{row.createdAtLabel}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
