"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type GroupRow = {
  id: string;
  name: string;
  leverage: number;
  marginCallLevel: string;
  stopOutLevel: string;
  isDefault: boolean;
};

const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #ccc" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };

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
      }),
    });
    setCreating(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create group");
      return;
    }
    setNewName("");
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
    <>
      <h2>Create group</h2>
      <form onSubmit={createGroup} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: "2rem" }}>
        <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ width: 140 }} />
        <input
          type="text"
          inputMode="numeric"
          placeholder="Leverage"
          value={newLeverage}
          onChange={(e) => setNewLeverage(e.target.value)}
          style={{ width: 90, fontFamily: "monospace" }}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Margin call %"
          value={newCallLevel}
          onChange={(e) => setNewCallLevel(e.target.value)}
          style={{ width: 100, fontFamily: "monospace" }}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Stop out %"
          value={newStopOutLevel}
          onChange={(e) => setNewStopOutLevel(e.target.value)}
          style={{ width: 90, fontFamily: "monospace" }}
        />
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={newIsDefault} onChange={(e) => setNewIsDefault(e.target.checked)} /> Default
        </label>
        <button type="submit" disabled={creating}>
          {creating ? "Creating..." : "Create group"}
        </button>
        {createError ? <span style={{ color: "crimson" }}>{createError}</span> : null}
      </form>

      <h2>Groups</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={th}>Name</th>
            <th align="right" style={th}>Leverage</th>
            <th align="right" style={th}>Margin call %</th>
            <th align="right" style={th}>Stop out %</th>
            <th align="center" style={th}>Default</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ padding: "12px 8px", color: "#999" }}>No groups yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td style={td}>
                  <input
                    value={row.name}
                    onChange={(e) => updateRow(row.id, { name: e.target.value })}
                    style={{ width: 120 }}
                  />
                </td>
                <td align="right" style={td}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={row.leverage}
                    onChange={(e) => updateRow(row.id, { leverage: Number(e.target.value) || 0 })}
                    style={{ width: 70, fontFamily: "monospace" }}
                  />
                </td>
                <td align="right" style={td}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.marginCallLevel}
                    onChange={(e) => updateRow(row.id, { marginCallLevel: e.target.value })}
                    style={{ width: 80, fontFamily: "monospace" }}
                  />
                </td>
                <td align="right" style={td}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.stopOutLevel}
                    onChange={(e) => updateRow(row.id, { stopOutLevel: e.target.value })}
                    style={{ width: 70, fontFamily: "monospace" }}
                  />
                </td>
                <td align="center" style={td}>
                  <input
                    type="checkbox"
                    checked={row.isDefault}
                    onChange={(e) => updateRow(row.id, { isDefault: e.target.checked })}
                  />
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button type="button" disabled={savingId === row.id} onClick={() => save(row)}>
                    {savingId === row.id ? "Saving..." : "Save"}
                  </button>
                  {savedId === row.id ? <span style={{ color: "green", marginLeft: 6 }}>Saved</span> : null}
                  {errors[row.id] ? <span style={{ color: "crimson", marginLeft: 6 }}>{errors[row.id]}</span> : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
