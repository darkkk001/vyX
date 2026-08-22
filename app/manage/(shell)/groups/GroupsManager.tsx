"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormField } from "@/components/ui/FormField";
import { LeverageInput } from "@/components/ui/LeverageInput";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
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
  forceDealingMode: boolean;
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
  const [newForceDealingMode, setNewForceDealingMode] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [symbolsFor, setSymbolsFor] = useState<GroupRow | null>(null);

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
        forceDealingMode: newForceDealingMode,
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
    setNewForceDealingMode(false);
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
        <form onSubmit={createGroup} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <FormField label="Name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} required />
            </FormField>
            <FormField label="Leverage">
              <LeverageInput value={newLeverage} onChange={(e) => setNewLeverage(e.target.value)} />
            </FormField>
            <FormField label="Margin call %">
              <Input type="text" inputMode="decimal" mono value={newCallLevel} onChange={(e) => setNewCallLevel(e.target.value)} />
            </FormField>
            <FormField label="Stop out %">
              <Input type="text" inputMode="decimal" mono value={newStopOutLevel} onChange={(e) => setNewStopOutLevel(e.target.value)} />
            </FormField>
            <FormField label="Max lot">
              <Input
                type="text"
                inputMode="decimal"
                mono
                placeholder="blank = no override"
                value={newMaxLotSize}
                onChange={(e) => setNewMaxLotSize(e.target.value)}
              />
            </FormField>
            <FormField label="Trading restriction">
              <Select value={newTradingRestriction} onChange={(e) => setNewTradingRestriction(e.target.value as "BOTH" | "BUY_ONLY" | "SELL_ONLY")}>
                <option value="BOTH">Both</option>
                <option value="BUY_ONLY">Buy only</option>
                <option value="SELL_ONLY">Sell only</option>
              </Select>
            </FormField>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <Checkbox
              label="Swap-free"
              title="No overnight swap/rollover charged on positions held in this group"
              checked={newSwapFree}
              onChange={(e) => setNewSwapFree(e.target.checked)}
            />
            <Checkbox
              label="Default group"
              title="New accounts are placed in this group automatically when no group is chosen at creation"
              checked={newIsDefault}
              onChange={(e) => setNewIsDefault(e.target.checked)}
            />
            <Checkbox
              label="Force dealing"
              title="Route this group's market orders to the dealing queue for manual review, independent of the broker-wide setting"
              checked={newForceDealingMode}
              onChange={(e) => setNewForceDealingMode(e.target.checked)}
            />
            <Button type="submit" variant="primary" disabled={creating}>
              {creating ? "Creating..." : "Create group"}
            </Button>
            {createError ? <span className="text-sm text-[var(--sell)]">{createError}</span> : null}
          </div>
        </form>
      </Card>

      <Card title="Groups">
        <Table>
          <TableHead>
            <TableHeaderCell className="min-w-[150px]">Name</TableHeaderCell>
            <TableHeaderCell className="min-w-[130px]">Leverage</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[85px]">Margin call %</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[75px]">Stop out %</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[75px]">Max lot</TableHeaderCell>
            <TableHeaderCell className="min-w-[115px]">Restriction</TableHeaderCell>
            <TableHeaderCell align="center" className="min-w-[65px]">Swap-free</TableHeaderCell>
            <TableHeaderCell align="center" className="min-w-[65px]">Default</TableHeaderCell>
            <TableHeaderCell align="center" className="min-w-[80px]" title="Route this group's market orders to the dealing queue for manual review, independent of the broker-wide setting">
              Dealing
            </TableHeaderCell>
            <TableHeaderCell className="min-w-[190px]" />
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={9}>No groups yet.</TableEmptyState>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="min-w-[150px]">
                    <Input value={row.name} onChange={(e) => updateRow(row.id, { name: e.target.value })} className="w-full" />
                  </TableCell>
                  <TableCell className="min-w-[130px]">
                    <LeverageInput
                      value={row.leverage}
                      onChange={(e) => updateRow(row.id, { leverage: Number(e.target.value) || 0 })}
                    />
                  </TableCell>
                  <TableCell align="right" className="min-w-[85px]">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={row.marginCallLevel}
                      onChange={(e) => updateRow(row.id, { marginCallLevel: e.target.value })}
                      className="w-full text-right"
                    />
                  </TableCell>
                  <TableCell align="right" className="min-w-[75px]">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={row.stopOutLevel}
                      onChange={(e) => updateRow(row.id, { stopOutLevel: e.target.value })}
                      className="w-full text-right"
                    />
                  </TableCell>
                  <TableCell align="right" className="min-w-[75px]">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="none"
                      value={row.maxLotSize}
                      onChange={(e) => updateRow(row.id, { maxLotSize: e.target.value })}
                      className="w-full text-right"
                    />
                  </TableCell>
                  <TableCell className="min-w-[115px]">
                    <Select
                      value={row.tradingRestriction}
                      onChange={(e) => updateRow(row.id, { tradingRestriction: e.target.value as "BOTH" | "BUY_ONLY" | "SELL_ONLY" })}
                      className="w-full"
                    >
                      <option value="BOTH">Both</option>
                      <option value="BUY_ONLY">Buy only</option>
                      <option value="SELL_ONLY">Sell only</option>
                    </Select>
                  </TableCell>
                  <TableCell align="center" className="min-w-[65px]">
                    <Checkbox
                      title="No overnight swap/rollover charged on positions held in this group"
                      checked={row.swapFree}
                      onChange={(e) => updateRow(row.id, { swapFree: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell align="center" className="min-w-[65px]">
                    <Checkbox
                      title="New accounts are placed in this group automatically when no group is chosen at creation"
                      checked={row.isDefault}
                      onChange={(e) => updateRow(row.id, { isDefault: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell align="center" className="min-w-[80px]">
                    <Checkbox
                      title="Route this group's market orders to the dealing queue for manual review, independent of the broker-wide setting"
                      checked={row.forceDealingMode}
                      onChange={(e) => updateRow(row.id, { forceDealingMode: e.target.checked })}
                    />
                  </TableCell>
                  <TableCell className="min-w-[190px] whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={savingId === row.id} onClick={() => save(row)}>
                        {savingId === row.id ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSymbolsFor(row)}>
                        Symbols
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

      {symbolsFor ? <SymbolsModal row={symbolsFor} onClose={() => setSymbolsFor(null)} /> : null}
    </div>
  );
}

type SymbolOption = { id: string; name: string; category: string };
type GroupSymbolsData = { restrictSymbols: boolean; allowedSymbolIds: string[]; availableSymbols: SymbolOption[] };

// Opt-in per-group symbol allowlist -- unchecked (restrictSymbols=false)
// is the default every group already had before this existed, so
// nothing changes for a group until an admin deliberately turns this on
// here. See lib/risk.ts's checkGroupAllowedSymbol for the enforcement
// side, and app/api/manage/symbols/[id]/sessions/route.ts's Sessions
// modal (SymbolConfigTable.tsx) for the "replace whole list" precedent
// this mirrors.
function SymbolsModal({ row, onClose }: { row: GroupRow; onClose: () => void }) {
  const [data, setData] = useState<GroupSymbolsData | null>(null);
  const [restrictSymbols, setRestrictSymbols] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/manage/groups/${row.id}/symbols`)
      .then((r) => r.json())
      .then((d: GroupSymbolsData) => {
        setData(d);
        setRestrictSymbols(d.restrictSymbols);
        setSelected(new Set(d.allowedSymbolIds));
      })
      .catch(() => setError("failed to load"));
  }, [row.id]);

  function toggleSymbol(symbolId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbolId)) next.delete(symbolId);
      else next.add(symbolId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/manage/groups/${row.id}/symbols`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restrictSymbols, symbolIds: Array.from(selected) }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={`Symbols — ${row.name}`}>
      <div className="flex flex-col gap-3">
        <Checkbox
          label="Restrict this group to only the symbols checked below"
          checked={restrictSymbols}
          onChange={(e) => setRestrictSymbols(e.target.checked)}
        />
        <p className="text-xs text-[var(--text-3)]">
          {restrictSymbols
            ? "Accounts in this group can only trade the symbols checked below -- an order in any other symbol is rejected."
            : "Unchecked (default) -- accounts in this group can trade every symbol enabled for this broker, same as before this feature existed."}
        </p>
        {data === null ? (
          <p className="text-sm text-[var(--text-3)]">Loading...</p>
        ) : data.availableSymbols.length === 0 ? (
          <p className="text-sm text-[var(--text-3)]">No symbols enabled for this broker yet -- enable some on the Symbols page first.</p>
        ) : (
          <div className="grid max-h-80 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-lg border border-[var(--border)] p-3 sm:grid-cols-3">
            {data.availableSymbols.map((s) => (
              <Checkbox key={s.id} label={s.name} checked={selected.has(s.id)} onChange={() => toggleSymbol(s.id)} />
            ))}
          </div>
        )}
        {error ? <p className="text-sm text-[var(--sell)]">{error}</p> : null}
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving || data === null} onClick={save}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}
