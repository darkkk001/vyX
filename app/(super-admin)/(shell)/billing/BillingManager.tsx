"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { PLAN_PRICING, formatUsd } from "@/lib/billing";

type BillingRow = {
  id: string;
  name: string;
  tier: "STANDARD" | "WHITE_LABEL";
  status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "DISABLED";
  nextInvoiceAt: string | null;
};

const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;

// No client component existed for this page at all before -- the Server
// Component rendered this table directly. Self-fetches from the
// already-existing /api/admin/brokers GET (BrokersManager's own data
// source, extended with nextInvoiceAt) instead of a separate Server
// Component Prisma query.
export default function BillingManager() {
  const [rows, setRows] = useState<BillingRow[] | null>(null);

  useEffect(() => {
    fetch("/api/admin/brokers")
      .then((r) => r.json())
      .then((d: { rows: BillingRow[] }) => setRows(d.rows))
      .catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Broker</TableHeaderCell>
        <TableHeaderCell>Plan</TableHeaderCell>
        <TableHeaderCell align="right">Monthly</TableHeaderCell>
        <TableHeaderCell>Next invoice</TableHeaderCell>
        <TableHeaderCell>Billing status</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={5}>No brokers yet.</TableEmptyState>
        ) : (
          rows.map((b) => (
            <TableRow key={b.id}>
              <TableCell primary>{b.name}</TableCell>
              <TableCell>
                <Badge tone={b.tier === "WHITE_LABEL" ? "accent" : "neutral"}>{PLAN_PRICING[b.tier].label}</Badge>
              </TableCell>
              <TableCell align="right" mono>
                {formatUsd(PLAN_PRICING[b.tier].monthlyCents)}
              </TableCell>
              <TableCell className="text-[var(--text-3)]">
                {b.status === "TRIAL" ? "Trial — no charge yet" : b.nextInvoiceAt ? b.nextInvoiceAt.slice(0, 10) : "—"}
              </TableCell>
              <TableCell>
                <Badge tone={statusTone[b.status]}>{b.status}</Badge>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
