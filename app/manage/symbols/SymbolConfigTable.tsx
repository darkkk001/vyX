"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Symbol</th>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Enabled</th>
            {NUMERIC_FIELDS.map((f) => (
              <th
                key={f.key}
                align="left"
                title={f.title}
                style={{ padding: "6px 8px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" }}
              >
                {f.label}
              </th>
            ))}
            <th style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbolId}>
              <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>
                {row.symbolName}
                <div style={{ fontSize: 11, color: "#999" }}>{row.category}</div>
              </td>
              <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                <input type="checkbox" checked={row.enabled} onChange={() => toggleEnabled(row.symbolId)} />
              </td>
              {NUMERIC_FIELDS.map((f) => (
                <td key={f.key} style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row[f.key] ?? ""}
                    placeholder={f.key === "maxExposure" ? "no limit" : undefined}
                    onChange={(e) => updateField(row.symbolId, f.key, e.target.value)}
                    style={{ width: f.width, fontFamily: "monospace" }}
                  />
                </td>
              ))}
              <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                <button type="button" disabled={savingId === row.symbolId} onClick={() => save(row)}>
                  {savingId === row.symbolId ? "Saving..." : "Save"}
                </button>
                {savedId === row.symbolId ? <span style={{ color: "green", marginLeft: 6 }}>Saved</span> : null}
                {errors[row.symbolId] ? (
                  <span style={{ color: "crimson", marginLeft: 6 }}>{errors[row.symbolId]}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
