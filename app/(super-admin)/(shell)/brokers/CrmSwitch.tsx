"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

// CRM module switch (owner brief 2026-11-03): ON = the Trader's Room answers on the broker's host and its backoffice
// shows the CRM tab; OFF = the platform as before. Read per request, so it takes effect at once.
export default function CrmSwitch({ brokerId, initialEnabled, onSaved }: { brokerId: string; initialEnabled: boolean; onSaved?: () => void }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/admin/brokers/${brokerId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ crmEnabled: next }) });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Save failed.");
      return;
    }
    setEnabled(next);
    onSaved?.();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "ON" : "OFF"}</Badge>
        <Button size="sm" variant={enabled ? "danger" : "primary"} disabled={saving} onClick={() => save(!enabled)}>
          {saving ? "Saving..." : enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
