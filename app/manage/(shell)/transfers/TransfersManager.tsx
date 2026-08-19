"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type TransferRow = {
  id: string;
  accountNumber: string;
  type: "TRANSFER_OUT" | "TRANSFER_IN";
  amount: string;
  note: string | null;
  createdAt: string;
};

export type AccountOption = { id: string; accountNumber: string; fullName: string };

export default function TransfersManager({ initialRows, accounts }: { initialRows: TransferRow[]; accounts: AccountOption[] }) {
  const router = useRouter();
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(false);
    const response = await fetch("/api/manage/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAccountId, toAccountId, amount, note }),
    });
    setBusy(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "transfer failed");
      return;
    }
    setSuccess(true);
    setAmount("");
    setNote("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-[18px]">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="From account">
            <Select value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)} className="w-56">
              <option value="">— select —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.fullName}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="To account">
            <Select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)} className="w-56">
              <option value="">— select —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountNumber} — {a.fullName}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Amount (USD)">
            <Input type="text" inputMode="decimal" mono placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
          </FormField>
          <FormField label="Note (required, logged in audit trail)">
            <Input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="w-64" placeholder="e.g. Client requested consolidation" />
          </FormField>
          <Button type="submit" variant="primary" disabled={busy || !fromAccountId || !toAccountId}>
            {busy ? "Transferring..." : "Transfer"}
          </Button>
        </div>
        {success ? <p className="mt-2 text-sm text-[var(--buy)]">Transfer completed.</p> : null}
        {error ? <p className="mt-2 text-sm text-[var(--sell)]">{error}</p> : null}
      </form>

      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Direction</TableHeaderCell>
          <TableHeaderCell align="right">Amount</TableHeaderCell>
          <TableHeaderCell>Note</TableHeaderCell>
          <TableHeaderCell>Time</TableHeaderCell>
        </TableHead>
        <TableBody>
          {initialRows.length === 0 ? (
            <TableEmptyState colSpan={5}>No transfers yet.</TableEmptyState>
          ) : (
            initialRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary mono>{row.accountNumber}</TableCell>
                <TableCell>
                  <Badge tone={row.type === "TRANSFER_IN" ? "success" : "neutral"}>{row.type === "TRANSFER_IN" ? "IN" : "OUT"}</Badge>
                </TableCell>
                <TableCell align="right" mono>{row.amount}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.note ?? "—"}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
