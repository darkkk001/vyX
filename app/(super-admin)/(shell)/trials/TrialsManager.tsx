"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type TrialRow = { id: string; name: string; createdAt: string; trialEndsAt: string };

type BrokerApiRow = { id: string; name: string; status: string; createdAt: string; trialEndsAt: string | null };

// Self-fetches from the already-existing /api/admin/brokers GET
// (BrokersManager's own data source) and filters to TRIAL status
// client-side, instead of a separate Server Component Prisma query.
export default function TrialsManager() {
  const [rows, setRows] = useState<TrialRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function reload() {
    return fetch("/api/admin/brokers")
      .then((r) => r.json())
      .then((d: { rows: BrokerApiRow[] }) =>
        setRows(
          d.rows
            .filter((b) => b.status === "TRIAL")
            .map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, trialEndsAt: b.trialEndsAt ? b.trialEndsAt.slice(0, 10) : "-" }))
        )
      );
  }

  useEffect(() => {
    reload().catch(() => setRows([]));
  }, []);

  async function activate(row: TrialRow) {
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/admin/brokers/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    setBusyId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: body.error ?? "activation failed" }));
      return;
    }
    reload().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Broker</TableHeaderCell>
        <TableHeaderCell>Trial started</TableHeaderCell>
        <TableHeaderCell>Trial ends</TableHeaderCell>
        <TableHeaderCell />
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={4}>No trials pending.</TableEmptyState>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell primary>{row.name}</TableCell>
              <TableCell className="text-[var(--text-3)]">{row.createdAt}</TableCell>
              <TableCell className="text-[var(--text-3)]">{row.trialEndsAt}</TableCell>
              <TableCell>
                <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => activate(row)}>
                  {busyId === row.id ? "Activating..." : "Activate now"}
                </Button>
                {errors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{errors[row.id]}</div> : null}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
