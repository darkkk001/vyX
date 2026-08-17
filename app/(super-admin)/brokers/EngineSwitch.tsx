"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function EngineSwitch({ brokerId, initialEngine }: { brokerId: string; initialEngine: "LEGACY" | "RUST" }) {
  const router = useRouter();
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
    router.refresh();
  }

  return (
    <div>
      <select value={engine} disabled={saving} onChange={(e) => save(e.target.value as "LEGACY" | "RUST")}>
        <option value="LEGACY">Legacy (Next.js/Prisma)</option>
        <option value="RUST">Rust engine</option>
      </select>
      {saving ? <span style={{ marginLeft: 6, fontSize: 12, color: "#999" }}>Saving...</span> : null}
      {saved ? <span style={{ marginLeft: 6, fontSize: 12, color: "green" }}>Saved</span> : null}
      {error ? <div style={{ color: "crimson", fontSize: 12 }}>{error}</div> : null}
      <div style={{ fontSize: 11, color: "#999", maxWidth: 220 }}>
        Not wired to trading yet -- config only, see ADR-003.
      </div>
    </div>
  );
}
