"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";

export type SymbolConfigRow = {
  symbolId: string;
  symbolName: string;
  category: string;
  digits: number;
  spreadMarkup: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  swapLong: string;
  swapShort: string;
  enabled: boolean;
  commissionPerLot: string;
  maxExposure: string | null;
};

type EditableField = "spreadMarkup" | "minLot" | "maxLot" | "lotStep" | "swapLong" | "swapShort" | "commissionPerLot" | "maxExposure";

const NUMERIC_FIELDS: { key: EditableField; label: string; title: string; width: number }[] = [
  { key: "spreadMarkup", label: "Spread markup", title: "Pips added on top of the raw spread", width: 100 },
  { key: "minLot", label: "Min lot", title: "Minimum order volume", width: 80 },
  { key: "maxLot", label: "Max lot", title: "Maximum order volume", width: 80 },
  { key: "lotStep", label: "Lot step", title: "Volume must be min lot + a whole number of this step", width: 80 },
  { key: "swapLong", label: "Swap long", title: "Account currency per lot per day, BUY positions", width: 90 },
  { key: "swapShort", label: "Swap short", title: "Account currency per lot per day, SELL positions", width: 90 },
  { key: "commissionPerLot", label: "Commission/lot", title: "Flat fee per lot, charged once at open", width: 100 },
  { key: "maxExposure", label: "Max exposure", title: "Max total open volume per account in this symbol — blank = no limit", width: 100 },
];

// MT5 Manager-style symbol grid: one row per symbol, every config field
// editable in place, one Save button per row. Mirrors
// app/(super-admin)/brokers/CreateBrokerForm.tsx's fetch/error/
// submitting-state shape, just per-row instead of a single form.
export default function SymbolConfigTable({ initialRows }: { initialRows: SymbolConfigRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<SymbolConfigRow[]>(initialRows);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  function updateField(symbolId: string, field: EditableField, value: string) {
    setRows((prev) => prev.map((r) => (r.symbolId === symbolId ? { ...r, [field]: value } : r)));
    setSavedId(null);
  }

  function toggleEnabled(symbolId: string) {
    setRows((prev) => prev.map((r) => (r.symbolId === symbolId ? { ...r, enabled: !r.enabled } : r)));
    setSavedId(null);
  }

  async function save(row: SymbolConfigRow) {
    setSavingId(row.symbolId);
    setErrors((prev) => ({ ...prev, [row.symbolId]: "" }));

    const response = await fetch("/api/manage/symbols", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });

    setSavingId(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.symbolId]: body.error ?? "save failed" }));
      return;
    }

    const updated = (await response.json()) as SymbolConfigRow;
    setRows((prev) => prev.map((r) => (r.symbolId === row.symbolId ? { ...r, ...updated } : r)));
    setSavedId(row.symbolId);
    router.refresh();
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Symbol</TableHeaderCell>
        <TableHeaderCell>Enabled</TableHeaderCell>
        {NUMERIC_FIELDS.map((f) => (
          <TableHeaderCell key={f.key} title={f.title} className="whitespace-nowrap">
            {f.label}
          </TableHeaderCell>
        ))}
        <TableHeaderCell />
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.symbolId}>
            <TableCell mono>
              {row.symbolName}
              <div className="text-xs text-slate-400">{row.category}</div>
            </TableCell>
            <TableCell>
              <Checkbox checked={row.enabled} onChange={() => toggleEnabled(row.symbolId)} />
            </TableCell>
            {NUMERIC_FIELDS.map((f) => (
              <TableCell key={f.key}>
                <Input
                  type="text"
                  inputMode="decimal"
                  mono
                  value={row[f.key] ?? ""}
                  placeholder={f.key === "maxExposure" ? "no limit" : undefined}
                  onChange={(e) => updateField(row.symbolId, f.key, e.target.value)}
                  style={{ width: f.width }}
                />
              </TableCell>
            ))}
            <TableCell className="whitespace-nowrap">
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={savingId === row.symbolId} onClick={() => save(row)}>
                  {savingId === row.symbolId ? "Saving..." : "Save"}
                </Button>
                {savedId === row.symbolId ? <span className="text-xs text-emerald-600">Saved</span> : null}
                {errors[row.symbolId] ? (
                  <span className="text-xs text-rose-600">{errors[row.symbolId]}</span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
