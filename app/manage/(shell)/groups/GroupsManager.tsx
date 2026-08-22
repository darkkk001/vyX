"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type GroupRow = {
  id: string;
  name: string;
  leverage: number;
  marginCallLevel: string;
  stopOutLevel: string;
  isDefault: boolean;
  maxLotSize: string;
  tradingRestriction: "BOTH" | "BUY_ONLY" | "SELL_ONLY";
  swapFree: boolean;
};

// Create form + editable list, same fetch/error/submitting-state shape
// as SymbolConfigTable.tsx (the symbols screen's own client component).
export default function GroupsManager({ initialRows }: { initialRows: GroupRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<GroupRow[]>(initialRows);

  const [newName, setNewName] = useState("");
  const [newLeverage, setNewLeverage] = useState("100");
  const [newCallLevel, setNewCallLevel] = useState("100");
  const [newStopOutLevel, setNewStopOutLevel] = useState("50");
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [newMaxLotSize, setNewMaxLotSize] = useState("");
  const [newTradingRestriction, setNewTradingRestriction] = useState<"BOTH" | "BUY_ONLY" | "SELL_ONLY">("BOTH");
  const [newSwapFree, setNewSwapFree] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  function updateRow(id: string, patch: Partial<GroupRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSavedId(null);
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName,
        leverage: newLeverage,
        marginCallLevel: newCallLevel,
        stopOutLevel: newStopOutLevel,
        isDefault: newIsDefault,
        maxLotSize: newMaxLotSize,
        tradingRestriction: newTradingRestriction,
        swapFree: newSwapFree,
      }),
    });
    setCreating(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create group");
      return;
    }
    const created: GroupRow = await response.json();
    // Server-rendered `rows` was seeded into useState once on mount, so
    // router.refresh() alone re-fetches the server component but never
    // flows back into this already-mounted state -- append the row we
    // just got back directly instead (same "only one default" rule the
    // API itself applies) rather than depending on a prop update.
    setRows((prev) => (created.isDefault ? prev.map((r) => ({ ...r, isDefault: false })) : prev).concat(created));
    setNewName("");
    setNewMaxLotSize("");
    setNewTradingRestriction("BOTH");
    setNewSwapFree(false);
    router.refresh();
  }

  async function save(row: GroupRow) {
    setSavingId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/groups/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    setSavingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: body.error ?? "save failed" }));
      return;
    }
    setSavedId(row.id);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Create group">
        <form onSubmit={createGroup} className="flex flex-wrap items-center gap-2">
          <Input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required className="w-36" />
          <Input
            type="text"
            inputMode="numeric"
            mono
            placeholder="Leverage"
            value={newLeverage}
            onChange={(e) => setNewLeverage(e.target.value)}
            className="w-24"
          />
          <Input
            type="text"
            inputMode="decimal"
            mono
            placeholder="Margin call %"
            value={newCallLevel}
            onChange={(e) => setNewCallLevel(e.target.value)}
            className="w-28"
          />
          <Input
            type="text"
            inputMode="decimal"
            mono
            placeholder="Stop out %"
            value={newStopOutLevel}
            onChange={(e) => setNewStopOutLevel(e.target.value)}
            className="w-24"
          />
          <Input
            type="text"
            inputMode="decimal"
            mono
            placeholder="Max lot (blank = no override)"
            value={newMaxLotSize}
            onChange={(e) => setNewMaxLotSize(e.target.value)}
            className="w-24"
          />
          <Select value={newTradingRestriction} onChange={(e) => setNewTradingRestriction(e.target.value as "BOTH" | "BUY_ONLY" | "SELL_ONLY")} className="w-32">
            <option value="BOTH">Both</option>
            <option value="BUY_ONLY">Buy only</option>
            <option value="SELL_ONLY">Sell only</option>
          </Select>
          <Checkbox label="Swap-free" checked={newSwapFree} onChange={(e) => setNewSwapFree(e.target.checked)} />
          <Checkbox label="Default" checked={newIsDefault} onChange={(e) => setNewIsDefault(e.target.checked)} />
          <Button type="submit" variant="primary" disabled={creating}>
            {creating ? "Creating..." : "Create group"}
          </Button>
          {createError ? <span className="text-sm text-[var(--sell)]">{createError}</span> : null}
        </form>
      </Card>

      <Card title="Groups">
        <Table>
          <TableHead>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell align="right">Leverage</TableHeaderCell>
            <TableHeaderCell align="right">Margin call %</TableHeaderCell>
            <TableHeaderCell align="right">Stop out %</TableHeaderCell>
            <TableHeaderCell align="right">Max lot</TableHeaderCell>
            <TableHeaderCell>Restriction</TableHeaderCell>
            <TableHeaderCell align="center">Swap-free</TableHeaderCell>
            <TableHeaderCell align="center">Default</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={9}>No groups yet.</TableEmptyState>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Input value={row.name} onChange={(e) => updateRow(row.id, { name: e.target.value })} className="w-32" />
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="numeric"
                      mono
                      value={row.leverage}
                      onChange={(e) => updateRow(row.id, { leverage: Number(e.target.value) || 0 })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={row.marginCallLevel}
                      onChange={(e) => updateRow(row.id, { marginCallLevel: e.target.value })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={row.stopOutLevel}
                      onChange={(e) => updateRow(row.id, { stopOutLevel: e.target.value })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="none"
                      value={row.maxLotSize}
                      onChange={(e) => updateRow(row.id, { maxLotSize: e.target.value })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={row.tradingRestriction}
                      onChange={(e) => updateRow(row.id, { tradingRestriction: e.target.value as "BOTH" | "BUY_ONLY" | "SELL_ONLY" })}
                      className="w-32"
                    >
                      <option value="BOTH">Both</option>
                      <option value="BUY_ONLY">Buy only</option>
                      <option value="SELL_ONLY">Sell only</option>
                    </Select>
                  </TableCell>
                  <TableCell align="center">
                    <Checkbox checked={row.swapFree} onChange={(e) => updateRow(row.id, { swapFree: e.target.checked })} />
                  </TableCell>
                  <TableCell align="center">
                    <Checkbox checked={row.isDefault} onChange={(e) => updateRow(row.id, { isDefault: e.target.checked })} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={savingId === row.id} onClick={() => save(row)}>
                        {savingId === row.id ? "Saving..." : "Save"}
                      </Button>
                      {savedId === row.id ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
                      {errors[row.id] ? <span className="text-xs text-[var(--sell)]">{errors[row.id]}</span> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
