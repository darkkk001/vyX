"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

// Phase 2 pricing engine cutover switch -- same shape as this directory's
// own EngineSwitch.tsx, one level more consequential: OFF (the default,
// every broker today) means every fill and the daily swap job keep
// resolving pricing exactly as before (group-only) -- ON switches that
// SAME broker's fills to the full Account > AccountType > Group >
// BrokerSymbol resolver (lib/pricing-engine.ts), including whatever
// AccountType/per-symbol/swap-free config that broker has saved. This is
// a real, immediate, money-affecting change the moment it's flipped ON --
// only flip it after that broker's shadow comparison
// (lib/pricing-shadow-compare.ts / GET /api/manage/pricing-shadow-compare)
// has been reviewed and shows no unexpected diffs.
export default function PricingEngineSwitch({
  brokerId,
  initialEnabled,
  onSaved,
}: {
  brokerId: string;
  initialEnabled: boolean;
  onSaved?: () => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/admin/brokers/${brokerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pricingEngineEnabled: next }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "save failed");
      return;
    }
    setEnabled(next);
    setConfirming(false);
    onSaved?.();
  }

  function handleToggleClick() {
    // Turning ON is the consequential direction (starts charging real
    // fills at the new resolution) -- require an explicit second click,
    // same "don't let one misclick flip a money-path switch" reasoning as
    // this app's other irreversible-ish actions. Turning OFF (reverting
    // to the always-safe old behavior) needs no confirmation.
    if (!enabled && !confirming) {
      setConfirming(true);
      return;
    }
    save(!enabled);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "ON" : "OFF"}</Badge>
        {confirming ? (
          <>
            <span className="text-xs text-[var(--text-3)]">Really enable? Fills switch to the new resolver immediately.</span>
            <Button size="sm" variant="danger" disabled={saving} onClick={() => save(true)}>
              {saving ? "Saving..." : "Yes, enable"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant={enabled ? "danger" : "primary"} disabled={saving} onClick={handleToggleClick}>
            {saving ? "Saving..." : enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
