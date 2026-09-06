"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

// Shared per-symbol pricing editor -- backs all three levels of the
// Phase 2 pricing engine's per-symbol override tables (GroupSymbolConfig,
// AccountTypeSymbolConfig, AccountSymbolConfig), which have had an
// identical 5-field shape (spreadMarkup, targetTotalSpreadPips,
// commissionPerLot, swapLong, swapShort) since the 2026-09-07 nullable-
// widening migration. Each of the three GET routes normalizes its own
// "what does this row fall back to if unset" concept into the same
// defaultSpreadMarkup/defaultCommissionPerLot/defaultSwapLong/
// defaultSwapShort field names (see each route's own comment for what
// "default" actually means one level down for that specific table), so
// this component never needs to know which of the three it's talking to.
//
// Blank = null = inherit (not zero) -- see lib/pricing-editor-shared.ts's
// own comment for why this is a deliberate change from the pre-Stage-5
// GroupSymbolConfig editor, which coerced blank to an explicit 0 back
// when null wasn't a real option. spreadMarkup and targetTotalSpreadPips
// are mutually exclusive per row (Q2, 2026-09-07 design decision) --
// expressed here as a per-row mode toggle rather than two simultaneously
// editable fields, so there's no way to accidentally set both from this UI.
type ApiRow = {
  symbolId: string;
  symbolName: string;
  category: string;
  hasOverride: boolean;
  spreadMarkup: string | null;
  targetTotalSpreadPips: string | null;
  commissionPerLot: string | null;
  swapLong: string | null;
  swapShort: string | null;
  defaultSpreadMarkup: string | null;
  defaultCommissionPerLot: string | null;
  defaultSwapLong: string | null;
  defaultSwapShort: string | null;
};

type EditRow = {
  symbolId: string;
  symbolName: string;
  hasOverride: boolean;
  mode: "markup" | "target";
  spreadMarkup: string; // "" means null/inherit
  targetTotalSpreadPips: string;
  commissionPerLot: string;
  swapLong: string;
  swapShort: string;
  defaultSpreadMarkup: string | null;
  defaultCommissionPerLot: string | null;
  defaultSwapLong: string | null;
  defaultSwapShort: string | null;
};

function toEditRow(r: ApiRow): EditRow {
  return {
    symbolId: r.symbolId,
    symbolName: r.symbolName,
    hasOverride: r.hasOverride,
    mode: r.targetTotalSpreadPips !== null ? "target" : "markup",
    spreadMarkup: r.spreadMarkup ?? "",
    targetTotalSpreadPips: r.targetTotalSpreadPips ?? "",
    commissionPerLot: r.commissionPerLot ?? "",
    swapLong: r.swapLong ?? "",
    swapShort: r.swapShort ?? "",
    defaultSpreadMarkup: r.defaultSpreadMarkup,
    defaultCommissionPerLot: r.defaultCommissionPerLot,
    defaultSwapLong: r.defaultSwapLong,
    defaultSwapShort: r.defaultSwapShort,
  };
}

// Small muted hint shown under a blank field -- "inherits: 0.05" when the
// next level down has a real value, "inherits" alone when it doesn't
// (inherits further, not resolved by this editor).
function InheritHint({ value }: { value: string | null }) {
  return <div className="text-[10px] leading-tight text-[var(--text-3)]">{value !== null ? `inherits: ${value}` : "inherits"}</div>;
}

export function SymbolPricingEditor({
  apiPath,
  description,
  onOverrideCountChange,
}: {
  apiPath: string;
  description: string;
  // Fires whenever the number of symbols with an active override changes
  // -- lets a parent (e.g. the account page's "Custom Pricing" section
  // header) show a live badge without duplicating this component's own
  // fetch/state.
  onOverrideCountChange?: (count: number) => void;
}) {
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(apiPath)
      .then((r) => r.json())
      .then((data: ApiRow[]) => setRows(data.map(toEditRow)))
      .catch(() => setRows([]));
  }, [apiPath]);

  useEffect(() => {
    if (rows) onOverrideCountChange?.(rows.filter((r) => r.hasOverride).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOverrideCountChange is expected to be stable enough not to re-trigger the fetch above; only `rows` should drive this.
  }, [rows]);

  function update(symbolId: string, patch: Partial<EditRow>) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, ...patch } : r)));
  }

  async function save(row: EditRow) {
    setSavingId(row.symbolId);
    setErrors((prev) => ({ ...prev, [row.symbolId]: "" }));
    const response = await fetch(apiPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbolId: row.symbolId,
        spreadMarkup: row.mode === "markup" ? row.spreadMarkup || null : null,
        targetTotalSpreadPips: row.mode === "target" ? row.targetTotalSpreadPips || null : null,
        commissionPerLot: row.commissionPerLot || null,
        swapLong: row.swapLong || null,
        swapShort: row.swapShort || null,
      }),
    });
    setSavingId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.symbolId]: b.error ?? "save failed" }));
      return;
    }
    const saved: ApiRow = await response.json();
    update(row.symbolId, { ...toEditRow({ ...saved, defaultSpreadMarkup: row.defaultSpreadMarkup, defaultCommissionPerLot: row.defaultCommissionPerLot, defaultSwapLong: row.defaultSwapLong, defaultSwapShort: row.defaultSwapShort }) });
  }

  async function reset(row: EditRow) {
    setSavingId(row.symbolId);
    setErrors((prev) => ({ ...prev, [row.symbolId]: "" }));
    const response = await fetch(apiPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbolId: row.symbolId, reset: true }),
    });
    setSavingId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.symbolId]: b.error ?? "reset failed" }));
      return;
    }
    update(row.symbolId, {
      hasOverride: false,
      mode: "markup",
      spreadMarkup: "",
      targetTotalSpreadPips: "",
      commissionPerLot: "",
      swapLong: "",
      swapShort: "",
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-3)]">{description}</p>
      {rows === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No symbols enabled yet.</p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHead>
              <TableHeaderCell className="!px-3">Symbol</TableHeaderCell>
              <TableHeaderCell className="!px-3">Spread mode</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Spread / Target</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Commission</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Swap L</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Swap S</TableHeaderCell>
              <TableHeaderCell className="!px-3" />
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.symbolId}>
                  <TableCell mono className="!px-3">
                    {row.symbolName}
                  </TableCell>
                  <TableCell className="!px-3">
                    <Select
                      value={row.mode}
                      onChange={(e) => update(row.symbolId, { mode: e.target.value as "markup" | "target" })}
                      className="w-28 !py-1 text-xs"
                    >
                      <option value="markup">Markup</option>
                      <option value="target">Target</option>
                    </Select>
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    {row.mode === "markup" ? (
                      <>
                        <Input
                          type="text"
                          inputMode="decimal"
                          mono
                          placeholder="inherit"
                          value={row.spreadMarkup}
                          onChange={(e) => update(row.symbolId, { spreadMarkup: e.target.value })}
                          className="w-20 text-right"
                        />
                        {row.spreadMarkup === "" ? <InheritHint value={row.defaultSpreadMarkup} /> : null}
                      </>
                    ) : (
                      <Input
                        type="text"
                        inputMode="decimal"
                        mono
                        placeholder="total pips"
                        value={row.targetTotalSpreadPips}
                        onChange={(e) => update(row.symbolId, { targetTotalSpreadPips: e.target.value })}
                        className="w-20 text-right"
                      />
                    )}
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="inherit"
                      value={row.commissionPerLot}
                      onChange={(e) => update(row.symbolId, { commissionPerLot: e.target.value })}
                      className="w-20 text-right"
                    />
                    {row.commissionPerLot === "" ? <InheritHint value={row.defaultCommissionPerLot} /> : null}
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="inherit"
                      value={row.swapLong}
                      onChange={(e) => update(row.symbolId, { swapLong: e.target.value })}
                      className="w-16 text-right"
                    />
                    {row.swapLong === "" ? <InheritHint value={row.defaultSwapLong} /> : null}
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="inherit"
                      value={row.swapShort}
                      onChange={(e) => update(row.symbolId, { swapShort: e.target.value })}
                      className="w-16 text-right"
                    />
                    {row.swapShort === "" ? <InheritHint value={row.defaultSwapShort} /> : null}
                  </TableCell>
                  <TableCell className="!px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" disabled={savingId === row.symbolId} onClick={() => save(row)}>
                        {savingId === row.symbolId ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={savingId === row.symbolId || !row.hasOverride} onClick={() => reset(row)}>
                        Reset
                      </Button>
                    </div>
                    {errors[row.symbolId] ? <div className="mt-1 text-xs text-[var(--sell)]">{errors[row.symbolId]}</div> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
