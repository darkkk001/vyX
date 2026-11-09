"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormField } from "@/components/ui/FormField";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { plainError } from "@/lib/plain-error";

export type RoutingRuleRow = {
  id: string;
  liquidityProviderName: string;
  liquidityProviderStatus: "PROSPECTIVE" | "NEGOTIATING" | "CONTRACTED" | "CONNECTED";
  symbolName: string | null;
  groupId: string | null;
  groupName: string | null;
  priority: number;
  weight: string;
  enabled: boolean;
  notes: string | null;
};
export type LpOption = { id: string; name: string };
export type SymbolOption = { id: string; name: string };
export type GroupOption = { id: string; name: string; category: string };

/** A weight the server accepts (lib/lp-routing-input.ts): a number above 0, at most 1,000,000. */
function weightProblem(text: string): string | null {
  const w = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(w) && w > 0 && w <= 1_000_000 ? null : "Weight must be a number above 0";
}

// Self-fetches from the already-existing /api/manage/lp-routing,
// /api/manage/liquidity-providers, /api/manage/symbols and /api/manage/groups GET routes
// instead of receiving them as server-rendered props -- both the
// website and a bundled manager-shell desktop app (no Server Component
// of its own) share this one path now.
//
// QoreBridge M5 fields (lib/lp-routing-input.ts): group (blank = every group; the most specific rule wins), weight
// (this provider's share of its level's volume) and on / off. Group, weight and on / off are edited in the table
// (PATCH /api/manage/lp-routing/[id], only the changed field is sent).
export default function LpRoutingManager() {
  const [rows, setRows] = useState<RoutingRuleRow[] | null>(null);
  const [lpOptions, setLpOptions] = useState<LpOption[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<SymbolOption[]>([]);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const [liquidityProviderId, setLiquidityProviderId] = useState("");
  const [groupId, setGroupId] = useState(""); // "" = every group
  const [symbolId, setSymbolId] = useState(""); // "" = broker-wide default
  const [priority, setPriority] = useState("1");
  const [weight, setWeight] = useState("1");
  const [enabled, setEnabled] = useState(true);
  const [notes, setNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // inline edit: the row being saved, each row's weight draft, and each row's last refusal
  const [savingId, setSavingId] = useState<string | null>(null);
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function load() {
    const [ruleRows, providers, symbols, groups] = await Promise.all([
      fetch("/api/manage/lp-routing").then((r) => r.json()),
      fetch("/api/manage/liquidity-providers").then((r) => r.json()),
      fetch("/api/manage/symbols").then((r) => r.json()),
      fetch("/api/manage/groups").then((r) => (r.ok ? r.json() : [])),
    ]);
    setRows(ruleRows);
    setWeightDrafts({});
    const lpOpts: LpOption[] = (providers as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name }));
    setLpOptions(lpOpts);
    // Neutral-defaults rule (2026-09-05): which LP handles a symbol's
    // orders is a real routing decision, so this no longer auto-selects
    // lpOpts[0] the moment providers load -- the create Button already
    // disables while empty, but that guard is meaningless if a value is
    // silently pre-chosen before the admin ever looks at the picker.
    setSymbolOptions((symbols as { symbolId: string; symbolName: string }[]).map((s) => ({ id: s.symbolId, name: s.symbolName })));
    setGroupOptions((groups as { id: string; name: string; category: string }[]).map((g) => ({ id: g.id, name: g.name, category: g.category })));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  // A rule only matters for a market-book (A-book) group, so the pickers list those; a rule that already names
  // another group keeps it in its own picker.
  const marketBookGroups = groupOptions.filter((g) => g.category === "A_BOOK");
  function groupChoicesFor(row: RoutingRuleRow): GroupOption[] {
    if (!row.groupId || marketBookGroups.some((g) => g.id === row.groupId)) return marketBookGroups;
    return [{ id: row.groupId, name: row.groupName ?? "Group", category: "" }, ...marketBookGroups];
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    const bad = weightProblem(weight);
    if (bad) {
      setCreateError(bad);
      return;
    }
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/lp-routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ liquidityProviderId, groupId: groupId || undefined, symbolId: symbolId || undefined, priority, weight: weight.trim(), enabled, notes }),
    });
    setCreating(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setCreateError(plainError(b, "Could not add the rule. Try again.", { audience: "staff" }));
      return;
    }
    setNotes("");
    load().catch(() => {});
  }

  /** Saves one field of a rule; a refusal is shown on that rule's row. */
  async function patchRule(id: string, fields: { groupId?: string | null; weight?: string; enabled?: boolean }) {
    setSavingId(id);
    setRowErrors((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    const response = await fetch(`/api/manage/lp-routing/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }).catch(() => null);
    setSavingId(null);
    if (!response || !response.ok) {
      const b = response ? await response.json().catch(() => ({})) : {};
      setRowErrors((m) => ({ ...m, [id]: plainError(b, "Could not save the change. Try again.", { audience: "staff" }) }));
    }
    load().catch(() => {});
  }

  function saveWeight(row: RoutingRuleRow) {
    const draft = weightDrafts[row.id];
    if (draft === undefined || draft.trim() === row.weight) return;
    const bad = weightProblem(draft);
    if (bad) {
      setRowErrors((m) => ({ ...m, [row.id]: bad }));
      return;
    }
    patchRule(row.id, { weight: draft.trim() });
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
            <Select value={liquidityProviderId} onChange={(e) => setLiquidityProviderId(e.target.value)} className="w-52" required>
              {lpOptions.length === 0 ? (
                <option value="">Add a provider first</option>
              ) : (
                <>
                  <option value="" disabled>
                    Select provider...
                  </option>
                  {lpOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </FormField>
          <FormField label="Group (blank = all groups)">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="w-44">
              <option value="">All groups</option>
              {marketBookGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Symbol (blank = all symbols)">
            <Select value={symbolId} onChange={(e) => setSymbolId(e.target.value)} className="w-40">
              <option value="">Default</option>
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
          <FormField label="Weight">
            <Input type="text" inputMode="decimal" mono value={weight} onChange={(e) => setWeight(e.target.value)} className="w-20" />
          </FormField>
          <FormField label="On">
            <div className="flex h-[38px] items-center">
              <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="Use this rule" />
            </div>
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
          <TableHeaderCell>Group</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell align="right">Priority</TableHeaderCell>
          <TableHeaderCell>Liquidity provider</TableHeaderCell>
          <TableHeaderCell align="right">Weight</TableHeaderCell>
          <TableHeaderCell>On</TableHeaderCell>
          <TableHeaderCell>Notes</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {rows === null ? (
            <TableEmptyState colSpan={8}>Loading...</TableEmptyState>
          ) : rows.length === 0 ? (
            <TableEmptyState colSpan={8}>No routing rules yet.</TableEmptyState>
          ) : (
            rows.map((row) => {
              const busy = savingId === row.id;
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Select
                      value={row.groupId ?? ""}
                      disabled={busy}
                      onChange={(e) => patchRule(row.id, { groupId: e.target.value || null })}
                      className="w-40"
                      aria-label="Group"
                    >
                      <option value="">All groups</option>
                      {groupChoicesFor(row).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                    {rowErrors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{rowErrors[row.id]}</div> : null}
                  </TableCell>
                  <TableCell mono>{row.symbolName ?? "Default (all symbols)"}</TableCell>
                  <TableCell align="right" mono>{row.priority}</TableCell>
                  <TableCell>
                    {row.liquidityProviderName} <Badge tone="neutral">{row.liquidityProviderStatus}</Badge>
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={weightDrafts[row.id] ?? row.weight}
                      disabled={busy}
                      onChange={(e) => setWeightDrafts((m) => ({ ...m, [row.id]: e.target.value }))}
                      onBlur={() => saveWeight(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveWeight(row);
                        if (e.key === "Escape") setWeightDrafts((m) => ({ ...m, [row.id]: row.weight }));
                      }}
                      className="w-20 text-right"
                      aria-label="Weight"
                    />
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      checked={row.enabled}
                      disabled={busy}
                      onChange={(e) => patchRule(row.id, { enabled: e.target.checked })}
                      aria-label="Use this rule"
                      label={row.enabled ? "On" : "Off"}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-[var(--text-3)]">{row.notes ?? ""}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" disabled={deletingId === row.id} onClick={() => deleteRule(row.id)}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
