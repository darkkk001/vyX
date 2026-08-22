"use client";

import { useRouter } from "next/navigation";
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

// Double-click takes a manager straight to whatever the log entry
// changed (e.g. double-clicking "Created account" opens that account) --
// see lib/audit-labels.ts's auditEntityHref for the entityType -> route
// map. A row with no known destination (href null) just isn't
// clickable, rather than navigating somewhere wrong.
export default function AuditLogTable({ rows }: { rows: AuditLogRow[] }) {
  const router = useRouter();

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
              onDoubleClick={() => row.href && router.push(row.href)}
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
