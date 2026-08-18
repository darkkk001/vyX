"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

export type TrialRow = { id: string; name: string; createdAt: string; trialEndsAt: string };

export default function TrialsManager({ initialRows }: { initialRows: TrialRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    router.refresh();
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
        {initialRows.map((row) => (
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
        ))}
      </TableBody>
    </Table>
  );
}
