"use client";

import { useState } from "react";
import { Select } from "@/components/ui/Select";

export default function EngineSwitch({
  brokerId,
  initialEngine,
  onSaved,
}: {
  brokerId: string;
  initialEngine: "LEGACY" | "RUST";
  onSaved?: () => void;
}) {
  const [engine, setEngine] = useState<"LEGACY" | "RUST">(initialEngine);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: "LEGACY" | "RUST") {
    setEngine(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    const response = await fetch(`/api/admin/brokers/${brokerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ executionEngine: next }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "save failed");
      return;
    }
    setSaved(true);
    onSaved?.();
  }

  return (
    <div>
      <Select value={engine} disabled={saving} onChange={(e) => save(e.target.value as "LEGACY" | "RUST")} className="w-40">
        <option value="LEGACY">Legacy</option>
        <option value="RUST">Rust engine</option>
      </Select>
      {saving ? <span className="ml-1.5 text-xs text-[var(--text-3)]">Saving...</span> : null}
      {saved ? <span className="ml-1.5 text-xs text-[var(--buy)]">Saved</span> : null}
      {error ? <div className="text-xs text-[var(--sell)]">{error}</div> : null}
    </div>
  );
}
