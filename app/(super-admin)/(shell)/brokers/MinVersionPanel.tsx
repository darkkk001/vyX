"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmSentence } from "@/lib/min-version-text";

// Mandatory-update policy (owner 2026-10-29): per app, the lowest version allowed to sign in and trade. Clients below it see "Update required" and
// update in one step. A minimum above the latest published version is refused (GET / PUT /api/admin/brokers/<id>/min-version).
type Row = { app: "terminal" | "backoffice"; minVersion: string | null; latestVersion: string | null; reason: string; setAt: string | null };

const LABEL: Record<Row["app"], string> = { terminal: "Terminal", backoffice: "Backoffice" };

function AppRow({ brokerId, row, onSaved }: { brokerId: string; row: Row; onSaved: (rows: Row[]) => void }) {
  const [draft, setDraft] = useState(row.minVersion ?? "");
  const [reason, setReason] = useState(row.reason);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = draft.trim().replace(/^v/i, "");
  const changed = v !== (row.minVersion ?? "");
  const sentence = v ? confirmSentence(v) : "";

  async function save(clear: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/brokers/${brokerId}/min-version`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(clear ? { app: row.app, minVersion: null, reason } : { app: row.app, minVersion: v, reason, confirm: typed }),
    });
    const out = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(out.error ?? "Save failed."); return; }
    setTyped("");
    onSaved(out.apps);
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] p-2">
      <div className="flex items-center gap-2">
        <span className="w-24 font-medium">{LABEL[row.app]}</span>
        <input aria-label={`${LABEL[row.app]} minimum version`} className="mono w-28 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-2 py-1" placeholder="none" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span className="text-[var(--text-3)]">Latest published: {row.latestVersion ? `v${row.latestVersion}` : "none"}</span>
        {row.minVersion ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(true)}>Remove</Button> : null}
      </div>
      {changed && v ? (
        <>
          <input aria-label="Reason (staff only)" className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-2 py-1" placeholder="Reason (staff only)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <span>Type to confirm: <span className="mono">{sentence}</span></span>
          <div className="flex items-center gap-2">
            <input aria-label="Confirmation" className="flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-2 py-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button size="sm" variant="primary" disabled={busy || typed !== sentence} onClick={() => save(false)}>{busy ? "Saving..." : "Set minimum"}</Button>
          </div>
        </>
      ) : null}
      {error ? <p className="text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}

export default function MinVersionPanel({ brokerId }: { brokerId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/brokers/${brokerId}/min-version`, { cache: "no-store" });
    if (res.ok) setRows((await res.json()).apps);
  }, [brokerId]);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <p className="text-xs text-[var(--text-3)]">Loading...</p>;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {rows.map((r) => <AppRow key={`${r.app}-${r.minVersion}-${r.setAt}`} brokerId={brokerId} row={r} onSaved={setRows} />)}
    </div>
  );
}
