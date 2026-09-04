"use client";

import { Fragment, useEffect, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type AuditLogRow = {
  id: string;
  actorEmail: string;
  actionLabel: string;
  brokerName: string | null;
  diffLines: string[];
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
            <Fragment key={row.id}>
              <TableRow
                onClick={() => row.diffLines.length > 0 && setExpandedId((prev) => (prev === row.id ? null : row.id))}
                title={row.diffLines.length > 0 ? "Click for details" : undefined}
                className={row.diffLines.length > 0 ? "cursor-pointer" : undefined}
              >
                <TableCell primary>{row.actorEmail}</TableCell>
                <TableCell>
                  {row.actionLabel}
                  {row.diffLines.length > 0 ? (
                    <span className="ml-1.5 text-[var(--text-3)]">{expandedId === row.id ? "▾" : "▸"}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-[var(--text-3)]">{row.brokerName ?? "-"}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAtLabel}</TableCell>
              </TableRow>
              {expandedId === row.id ? (
                <TableRow>
                  <TableCell colSpan={4} className="bg-[var(--bg-2)]">
                    <ul className="space-y-0.5 py-1 font-mono text-xs text-[var(--text-2)]">
                      {row.diffLines.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          ))
        )}
      </TableBody>
    </Table>
  );
}
