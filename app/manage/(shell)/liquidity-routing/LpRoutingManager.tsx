"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type RoutingRuleRow = {
  id: string;
  liquidityProviderName: string;
  liquidityProviderStatus: "PROSPECTIVE" | "NEGOTIATING" | "CONTRACTED" | "CONNECTED";
  symbolName: string | null;
  priority: number;
  notes: string | null;
};
export type LpOption = { id: string; name: string };
export type SymbolOption = { id: string; name: string };

export default function LpRoutingManager({
  initialRows,
  lpOptions,
  symbolOptions,
}: {
  initialRows: RoutingRuleRow[];
  lpOptions: LpOption[];
  symbolOptions: SymbolOption[];
}) {
  const router = useRouter();
  const [liquidityProviderId, setLiquidityProviderId] = useState(lpOptions[0]?.id ?? "");
  const [symbolId, setSymbolId] = useState(""); // "" = broker-wide default
  const [priority, setPriority] = useState("1");
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/lp-routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ liquidityProviderId, symbolId: symbolId || undefined, priority, notes }),
    });
    setCreating(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setCreateError(b.error ?? "failed to add rule");
      return;
    }
    setNotes("");
    router.refresh();
  }

  async function deleteRule(id: string) {
    setDeletingId(id);
    await fetch(`/api/manage/lp-routing/${id}`, { method: "DELETE" });
    setDeletingId(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={createRule} className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-[18px]">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Liquidity provider">
            <Select value={liquidityProviderId} onChange={(e) => setLiquidityProviderId(e.target.value)} className="w-52">
              {lpOptions.length === 0 ? (
                <option value="">— add a provider first —</option>
              ) : (
                lpOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))
              )}
            </Select>
          </FormField>
          <FormField label="Symbol (blank = broker-wide default)">
            <Select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} className="w-40">
              <option value="">— default —</option>
              {symbolOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Priority (1 = primary)">
            <Input type="text" inputMode="numeric" mono value={priority} onChange={(e) => setPriority(e.target.value)} className="w-20" />
          </FormField>
          <FormField label="Notes (optional)">
            <Input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-56" />
          </FormField>
          <Button type="submit" variant="primary" disabled={creating || !liquidityProviderId}>
            {creating ? "Adding..." : "Add rule"}
          </Button>
        </div>
        {createError ? <p className="mt-2 text-sm text-[var(--sell)]">{createError}</p> : null}
      </form>

      <Table>
        <TableHead>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell align="right">Priority</TableHeaderCell>
          <TableHeaderCell>Liquidity provider</TableHeaderCell>
          <TableHeaderCell>Notes</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {initialRows.length === 0 ? (
            <TableEmptyState colSpan={5}>No routing rules yet.</TableEmptyState>
          ) : (
            initialRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell mono>{row.symbolName ?? "Default (all symbols)"}</TableCell>
                <TableCell align="right" mono>{row.priority}</TableCell>
                <TableCell>
                  {row.liquidityProviderName} <Badge tone="neutral">{row.liquidityProviderStatus}</Badge>
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.notes ?? "—"}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" disabled={deletingId === row.id} onClick={() => deleteRule(row.id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
