"use client";

import { useEffect, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type AuditLogRow = {
  id: string;
  actorEmail: string;
  actionLabel: string;
  entityType: string;
  entityId: string;
  href: string | null;
  createdAtLabel: string;
};

// Self-fetches from /api/manage/audit on mount -- both the website and a
// bundled desktop shell (manager-shell/, which has no Server Component
// of its own to pre-fetch this) render this exact same component now,
// instead of the website baking rows into server-rendered props.
//
// Double-click takes a manager straight to whatever the log entry
// changed (e.g. double-clicking "Created account" opens that account) --
// see lib/audit-labels.ts's auditEntityHref for the entityType -> route
// map. A row with no known destination (href null) just isn't
// clickable. onOpenEntity defaults to a real page navigation (the
// website's exact previous behavior via next/navigation's router.push,
// now a plain hard navigation instead -- same reasoning as
// LogoutButton.tsx's own default) -- a bundled shell has no such route
// to navigate to yet and can override this later once it does.
export default function AuditLogTable({ onOpenEntity }: { onOpenEntity?: (href: string) => void }) {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);

  useEffect(() => {
    fetch("/api/manage/audit")
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
        <TableHeaderCell>Staff member</TableHeaderCell>
        <TableHeaderCell>Action</TableHeaderCell>
        <TableHeaderCell>Target</TableHeaderCell>
        <TableHeaderCell>Time</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={4}>No audit entries yet.</TableEmptyState>
        ) : (
          rows.map((row) => (
            <TableRow
              key={row.id}
              onDoubleClick={() => row.href && (onOpenEntity ? onOpenEntity(row.href) : (window.location.href = row.href))}
              title={row.href ? "Double-click to open" : undefined}
              className={row.href ? "cursor-pointer" : undefined}
            >
              <TableCell primary>{row.actorEmail}</TableCell>
              <TableCell>{row.actionLabel}</TableCell>
              <TableCell mono className="text-[var(--text-3)]">
                {row.entityType} · {row.entityId}
              </TableCell>
              <TableCell className="text-xs text-[var(--text-3)]">{row.createdAtLabel}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
