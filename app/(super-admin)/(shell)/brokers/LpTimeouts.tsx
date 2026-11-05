"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// Timeout / retry values of a broker's LP connections (Super Admin only, owner decision 2026-11-03: they are the platform
// operator's, never the broker's). GET /api/admin/lp-connections?broker=<subdomain>, PATCH /api/admin/lp-connections/[id].
// Empty = the bridge's own default (shown as the placeholder: prisma/schema.prisma LpConnection). Limits match lib/lp-connection-input.ts TIMEOUT_LIMITS.

const FIELDS = [
  { key: "ackTimeoutMs", label: "Ack timeout (ms)", max: 60_000, fallback: "5000" },
  { key: "orderTtlSecs", label: "Order TTL (s)", max: 3_600, fallback: "15" },
  { key: "maxAttempts", label: "Attempts", max: 20, fallback: "3" },
  { key: "reconcileTimeoutSecs", label: "Reconcile (s)", max: 600, fallback: "10" },
] as const;
type FieldKey = (typeof FIELDS)[number]["key"];
type Connection = { id: string; liquidityProviderName: string; role: string; enabled: boolean } & Record<FieldKey, number | null>;

function Row({ c, onSaved }: { c: Connection; onSaved: () => void }) {
  const [values, setValues] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, c[f.key] == null ? "" : String(c[f.key])])) as Record<FieldKey, string>,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const body: Record<string, number | null> = {};
    for (const f of FIELDS) {
      const t = values[f.key].trim();
      if (t === "") body[f.key] = null;
      else if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= f.max) body[f.key] = Number(t);
      else {
        setError(`${f.label}: a whole number from 1 to ${f.max}, or empty for the default.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    const response = await fetch(`/api/admin/lp-connections/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "Could not save.");
      return;
    }
    setSaved(true);
    onSaved();
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--border)] pb-2 last:border-b-0 last:pb-0">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold text-[var(--text-1)]">{c.liquidityProviderName}</span>
        <span className="text-[var(--text-3)]">{c.role}</span>
        {!c.enabled ? <span className="text-[var(--text-3)]">· disabled</span> : null}
      </div>
      <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] items-end gap-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-3)]">
            {f.label}
            <Input
              mono
              inputMode="numeric"
              placeholder={f.fallback}
              value={values[f.key]}
              onChange={(e) => {
                setValues((v) => ({ ...v, [f.key]: e.target.value }));
                setSaved(false);
              }}
            />
          </label>
        ))}
        <Button size="sm" variant="primary" disabled={saving} onClick={save} data-lp-save={c.id}>
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
      </div>
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}

export default function LpTimeouts({ brokerSlug }: { brokerSlug: string }) {
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/lp-connections?broker=${encodeURIComponent(brokerSlug)}`);
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error ?? "Could not load the connections.");
      setRows([]);
      return;
    }
    setError(null);
    setRows(await r.json());
  }, [brokerSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (rows === null) return <p className="text-xs text-[var(--text-3)]">Loading...</p>;
  if (error) return <p className="text-xs text-[var(--sell)]">{error}</p>;
  if (rows.length === 0) return <p className="text-xs text-[var(--text-3)]">No LP connections for this broker.</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((c) => (
        <Row key={c.id} c={c} onSaved={load} />
      ))}
    </div>
  );
}
