"use client";

import { useEffect, useState } from "react";
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

// Self-fetches from the already-existing /api/manage/lp-routing,
// /api/manage/liquidity-providers, and /api/manage/symbols GET routes
// instead of receiving all three as server-rendered props -- both the
// website and a bundled manager-shell desktop app (no Server Component
// of its own) share this one path now.
export default function LpRoutingManager() {
  const [rows, setRows] = useState<RoutingRuleRow[] | null>(null);
  const [lpOptions, setLpOptions] = useState<LpOption[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<SymbolOption[]>([]);
  const [liquidityProviderId, setLiquidityProviderId] = useState("");
  const [symbolId, setSymbolId] = useState(""); // "" = broker-wide default
  const [priority, setPriority] = useState("1");
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    const [ruleRows, providers, symbols] = await Promise.all([
      fetch("/api/manage/lp-routing").then((r) => r.json()),
      fetch("/api/manage/liquidity-providers").then((r) => r.json()),
      fetch("/api/manage/symbols").then((r) => r.json()),
    ]);
    setRows(ruleRows);
    const lpOpts: LpOption[] = (providers as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name }));
    setLpOptions(lpOpts);
    setLiquidityProviderId((prev) => prev || lpOpts[0]?.id || "");
    setSymbolOptions((symbols as { symbolId: string; symbolName: string }[]).map((s) => ({ id: s.symbolId, name: s.symbolName })));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

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
    load().catch(() => {});
  }

  async function deleteRule(id: string) {
    setDeletingId(id);
    await fetch(`/api/manage/lp-routing/${id}`, { method: "DELETE" });
    setDeletingId(null);
    load().catch(() => {});
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
          {rows === null ? (
            <TableEmptyState colSpan={5}>Loading...</TableEmptyState>
          ) : rows.length === 0 ? (
            <TableEmptyState colSpan={5}>No routing rules yet.</TableEmptyState>
          ) : (
            rows.map((row) => (
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
