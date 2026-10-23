"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DEFAULT_ORDER_BURST_UI, DEFAULT_ORDERS_PER_MINUTE_UI } from "./order-rate-defaults";

// Order rate limit per account for one broker (lib/order-rate-limit.ts). Empty = the platform default; 0 in either turns
// the cap off for this broker (e.g. a broker whose bots need more). Applies to new orders within a minute.
export default function OrderRateLimit({
  brokerId,
  initialBurst,
  initialPerMinute,
  onSaved,
}: {
  brokerId: string;
  initialBurst: number | null;
  initialPerMinute: number | null;
  onSaved?: () => void;
}) {
  const [burst, setBurst] = useState(initialBurst == null ? "" : String(initialBurst));
  const [perMinute, setPerMinute] = useState(initialPerMinute == null ? "" : String(initialPerMinute));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parse = (v: string): number | null | "bad" => {
    const t = v.trim();
    if (t === "") return null;
    return /^\d+$/.test(t) && Number(t) <= 100_000 ? Number(t) : "bad";
  };

  async function save() {
    const b = parse(burst);
    const m = parse(perMinute);
    if (b === "bad" || m === "bad") {
      setError("Enter a whole number from 0 to 100000, or leave it empty for the default.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    const response = await fetch(`/api/admin/brokers/${brokerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderBurst: b, orderPerMinute: m }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not save.");
      return;
    }
    setSaved(true);
    onSaved?.();
  }

  const off = burst.trim() === "0" || perMinute.trim() === "0";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-[var(--text-3)]">
          Burst
          <Input className="ml-2 w-24" inputMode="numeric" placeholder={String(DEFAULT_ORDER_BURST_UI)} value={burst} onChange={(e) => { setBurst(e.target.value); setSaved(false); }} />
        </label>
        <label className="text-xs text-[var(--text-3)]">
          Per minute
          <Input className="ml-2 w-24" inputMode="numeric" placeholder={String(DEFAULT_ORDERS_PER_MINUTE_UI)} value={perMinute} onChange={(e) => { setPerMinute(e.target.value); setSaved(false); }} />
        </label>
        <Button size="sm" variant="primary" disabled={saving} onClick={save}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
      <p className="text-xs text-[var(--text-3)]">{off ? "Off: no order limit for this broker." : "Empty fields use the default."}{saved ? " Saved." : ""}</p>
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
