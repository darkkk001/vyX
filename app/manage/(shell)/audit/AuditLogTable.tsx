"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type AuditOrderIdentity = {
  orderNumber: string;
  accountNumber: string | null;
  symbol: string | null;
  side: string | null;
  lots: string | null;
};

export type AuditLogRow = {
  id: string;
  actorEmail: string;
  actionLabel: string;
  entityType: string;
  entityId: string;
  href: string | null;
  order: AuditOrderIdentity | null;
  diffLines: string[];
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
//
// Broker feedback items 14+15 -- the "Order" column below (symbol, side,
// lots, and a short order number) is what makes an order/position
// lifecycle row identifiable at a glance, without expanding it -- this is
// dispute-resolution evidence, so it can't require a click to even see
// which order a row is about. The search box searches the exact same
// order number and account number this column shows (see
// app/api/manage/audit/route.ts's ?q= handling), so "client claims his
// SL was at X" is answerable by typing his account number or order id
// here, not by scrolling.
export default function AuditLogTable({ onOpenEntity }: { onOpenEntity?: (href: string) => void }) {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The mount fetch (empty query) and a just-typed filtered fetch are two
  // independent in-flight requests -- nothing guarantees the dev server
  // (or a slow network) resolves them in the order they were sent. Without
  // this guard, an unfiltered response that happens to land after a
  // filtered one silently clobbers it with the wrong (unfiltered) rows.
  // Only the response from the most recently issued request is ever applied.
  const latestRequestId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const requestId = ++latestRequestId.current;
    const timer = setTimeout(() => {
      fetch(`/api/manage/audit${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then((r) => r.json())
        .then((data) => {
          if (requestId === latestRequestId.current) setRows(data);
        })
        .catch(() => {
          if (requestId === latestRequestId.current) setRows([]);
        });
    }, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by order number or account number..."
        className="w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--bg-2)] px-3 py-1.5 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
      />
      {rows === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : (
        <Table>
          <TableHead>
            <TableHeaderCell>Staff member</TableHeaderCell>
            <TableHeaderCell>Action</TableHeaderCell>
            <TableHeaderCell>Order</TableHeaderCell>
            <TableHeaderCell>Target</TableHeaderCell>
            <TableHeaderCell>Time</TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={5}>{query ? "No audit entries match that search." : "No audit entries yet."}</TableEmptyState>
            ) : (
              rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    onClick={() => row.diffLines.length > 0 && setExpandedId((prev) => (prev === row.id ? null : row.id))}
                    onDoubleClick={() => row.href && (onOpenEntity ? onOpenEntity(row.href) : (window.location.href = row.href))}
                    title={row.href ? "Double-click to open" : row.diffLines.length > 0 ? "Click for details" : undefined}
                    className={row.href || row.diffLines.length > 0 ? "cursor-pointer" : undefined}
                  >
                    <TableCell primary>{row.actorEmail}</TableCell>
                    <TableCell>
                      {row.actionLabel}
                      {row.diffLines.length > 0 ? (
                        <span className="ml-1.5 text-[var(--text-3)]">{expandedId === row.id ? "▾" : "▸"}</span>
                      ) : null}
                    </TableCell>
                    <TableCell mono className="text-[var(--text-3)]">
                      {row.order ? (
                        <>
                          {row.order.symbol ? `${row.order.symbol} ` : ""}
                          {row.order.side ?? ""} {row.order.lots ?? ""}
                          <span className="text-[var(--text-3)]"> · #{row.order.orderNumber.slice(-8)}</span>
                          {row.order.accountNumber ? <span className="block text-[var(--text-3)]">{row.order.accountNumber}</span> : null}
                        </>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell mono className="text-[var(--text-3)]">
                      {row.entityType} · {row.entityId}
                    </TableCell>
                    <TableCell className="text-xs text-[var(--text-3)]">{row.createdAtLabel}</TableCell>
                  </TableRow>
                  {expandedId === row.id ? (
                    <TableRow>
                      <TableCell colSpan={5} className="bg-[var(--bg-2)]">
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
      )}
    </div>
  );
}
