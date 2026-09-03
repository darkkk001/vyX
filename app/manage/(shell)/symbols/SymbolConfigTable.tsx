"use client";

import { useEffect, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";

export type TradingMode = "BOTH" | "BUY_ONLY" | "SELL_ONLY";
export type BookType = "A_BOOK" | "B_BOOK";

export type SymbolConfigRow = {
  symbolId: string;
  brokerSymbolId: string | null;
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
  tradingMode: TradingMode;
  defaultBookType: BookType;
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
// Self-fetches from the already-existing /api/manage/symbols GET
// instead of receiving initialRows as a server-rendered prop -- both
// the website and a bundled manager-shell desktop app share this path.
export default function SymbolConfigTable() {
  const [rows, setRows] = useState<SymbolConfigRow[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [sessionsFor, setSessionsFor] = useState<SymbolConfigRow | null>(null);

  useEffect(() => {
    fetch("/api/manage/symbols")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  // Omni-search's "symbol -> symbol config" destination -- ?symbol=<name>
  // in the URL. window.location, not next/navigation's useSearchParams:
  // this component also bundles into manager-tauri's Vite shell.
  useEffect(() => {
    if (!rows) return;
    const target = new URLSearchParams(window.location.search).get("symbol");
    if (!target) return;
    const row = rows.find((r) => r.symbolName === target);
    if (!row) return;
    const el = document.getElementById(`symbol-row-${row.symbolId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "background-color 2s ease";
    el.style.backgroundColor = "var(--accent-bg)";
    const timer = setTimeout(() => { el.style.backgroundColor = ""; }, 2000);
    return () => clearTimeout(timer);
  }, [rows]);

  function updateField(symbolId: string, field: EditableField, value: string) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, [field]: value } : r)));
    setSavedId(null);
  }

  function toggleEnabled(symbolId: string) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, enabled: !r.enabled } : r)));
    setSavedId(null);
  }

  function updateTradingMode(symbolId: string, tradingMode: TradingMode) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, tradingMode } : r)));
    setSavedId(null);
  }

  function updateBookType(symbolId: string, defaultBookType: BookType) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, defaultBookType } : r)));
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
    setRows((prev) => prev && prev.map((r) => (r.symbolId === row.symbolId ? { ...r, ...updated } : r)));
    setSavedId(row.symbolId);
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell className="min-w-[130px]">Symbol</TableHeaderCell>
        <TableHeaderCell className="min-w-[80px]">Enabled</TableHeaderCell>
        <TableHeaderCell className="min-w-[140px]" title="Restrict which side can trade even when enabled">Trading mode</TableHeaderCell>
        <TableHeaderCell className="min-w-[110px]" title="Stamped onto every new position in this symbol -- record-keeping only, no real LP hedge happens">Book</TableHeaderCell>
        {NUMERIC_FIELDS.map((f) => (
          <TableHeaderCell key={f.key} title={f.title} className="whitespace-nowrap" style={{ minWidth: f.width + 24 }}>
            {f.label}
          </TableHeaderCell>
        ))}
        <TableHeaderCell className="min-w-[220px]" />
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.symbolId} id={`symbol-row-${row.symbolId}`}>
            <TableCell mono className="min-w-[130px]">
              {row.symbolName}
              <div className="text-xs text-[var(--text-3)]">{row.category}</div>
            </TableCell>
            <TableCell className="min-w-[80px]">
              <Checkbox checked={row.enabled} onChange={() => toggleEnabled(row.symbolId)} />
            </TableCell>
            <TableCell className="min-w-[140px]">
              <Select
                value={row.tradingMode}
                onChange={(e) => updateTradingMode(row.symbolId, e.target.value as TradingMode)}
                className="w-full"
              >
                <option value="BOTH">Both</option>
                <option value="BUY_ONLY">Buy only</option>
                <option value="SELL_ONLY">Sell only</option>
              </Select>
            </TableCell>
            <TableCell className="min-w-[110px]">
              <Select
                value={row.defaultBookType}
                onChange={(e) => updateBookType(row.symbolId, e.target.value as BookType)}
                className="w-full"
              >
                <option value="A_BOOK">A-Book</option>
                <option value="B_BOOK">B-Book</option>
              </Select>
            </TableCell>
            {NUMERIC_FIELDS.map((f) => (
              <TableCell key={f.key} style={{ minWidth: f.width + 24 }}>
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
            <TableCell className="min-w-[220px] whitespace-nowrap">
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={savingId === row.symbolId} onClick={() => save(row)}>
                  {savingId === row.symbolId ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!row.brokerSymbolId}
                  title={row.brokerSymbolId ? undefined : "Save this symbol's config first"}
                  onClick={() => setSessionsFor(row)}
                >
                  Sessions
                </Button>
                {savedId === row.symbolId ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
                {errors[row.symbolId] ? (
                  <span className="text-xs text-[var(--sell)]">{errors[row.symbolId]}</span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {sessionsFor ? <SessionsModal row={sessionsFor} onClose={() => setSessionsFor(null)} /> : null}
    </Table>
  );
}

type SessionRow = { id: string; dayOfWeek: number; openTime: string; closeTime: string };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Trading windows for one symbol -- empty list = always tradable (see
// lib/risk.ts's checkTradingSession). PUT replaces the whole list, so
// this fetches fresh on open and saves the full array on every change
// rather than tracking per-row add/delete against the server.
function SessionsModal({ row, onClose }: { row: SymbolConfigRow; onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [newDay, setNewDay] = useState("1");
  const [newOpen, setNewOpen] = useState("00:00");
  const [newClose, setNewClose] = useState("23:59");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/manage/symbols/${row.brokerSymbolId}/sessions`)
      .then((r) => r.json())
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [row.brokerSymbolId]);

  async function persist(next: SessionRow[]) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/manage/symbols/${row.brokerSymbolId}/sessions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: next.map((s) => ({ dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })) }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    setSessions(await response.json());
  }

  function addRow() {
    if (!sessions) return;
    persist([...sessions, { id: "", dayOfWeek: Number(newDay), openTime: newOpen, closeTime: newClose }]);
  }

  function removeRow(id: string) {
    if (!sessions) return;
    persist(sessions.filter((s) => s.id !== id));
  }

  return (
    <Modal open onClose={onClose} title={`Trading sessions — ${row.symbolName}`}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text-3)]">No sessions = always tradable. All times UTC.</p>
        {sessions === null ? (
          <p className="text-sm text-[var(--text-3)]">Loading...</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-[var(--text-3)]">No sessions set — always tradable.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm">
                <span className="font-mono">
                  {DAY_LABELS[s.dayOfWeek]} {s.openTime}–{s.closeTime}
                </span>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => removeRow(s.id)}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Select value={newDay} onChange={(e) => setNewDay(e.target.value)} className="w-28">
            {DAY_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </Select>
          <Input type="text" mono value={newOpen} onChange={(e) => setNewOpen(e.target.value)} className="w-20" placeholder="HH:MM" />
          <span className="text-[var(--text-3)]">–</span>
          <Input type="text" mono value={newClose} onChange={(e) => setNewClose(e.target.value)} className="w-20" placeholder="HH:MM" />
          <Button size="sm" disabled={saving || sessions === null} onClick={addRow}>
            Add
          </Button>
        </div>
        {error ? <p className="text-sm text-[var(--sell)]">{error}</p> : null}
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </ModalActions>
      </div>
    </Modal>
  );
}
