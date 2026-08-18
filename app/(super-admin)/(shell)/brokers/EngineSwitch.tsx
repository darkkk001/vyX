"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";

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
      <Select value={engine} disabled={saving} onChange={(e) => save(e.target.value as "LEGACY" | "RUST")} className="w-44">
        <option value="LEGACY">Legacy (Next.js/Prisma)</option>
        <option value="RUST">Rust engine</option>
      </Select>
      {saving ? <span className="ml-1.5 text-xs text-slate-400">Saving...</span> : null}
      {saved ? <span className="ml-1.5 text-xs text-emerald-600">Saved</span> : null}
      {error ? <div className="text-xs text-rose-600">{error}</div> : null}
      <div className="mt-1 max-w-[220px] text-xs text-slate-400">Not wired to trading yet — config only, see ADR-003.</div>
    </div>
  );
}
