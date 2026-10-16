"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

// Per-broker staff two-step sign-in policy (Broker.requireAdmin2fa), Super Admin only. Required: every staff member of
// the broker must have two-step sign-in. Optional: they may sign in without it (those who enrolled still enter a code).
// Lowering to Optional asks for an explicit confirm; raising is one click (staff without it enrol at their next request).
export default function StaffTwoFactorPolicy({
  brokerId,
  brokerName,
  initialRequired,
  onSaved,
}: {
  brokerId: string;
  brokerName: string;
  initialRequired: boolean;
  onSaved?: () => void;
}) {
  const [required, setRequired] = useState(initialRequired);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/admin/brokers/${brokerId}/staff-2fa`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ required: next, ...(next ? {} : { confirmOptional: true }) }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "save failed");
      return;
    }
    setRequired(next);
    setConfirming(false);
    onSaved?.();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={required ? "success" : "neutral"}>{required ? "Required" : "Optional"}</Badge>
        {confirming ? (
          <>
            <span className="text-xs text-[var(--text-3)]">Staff of {brokerName} will be able to sign in without two-step sign-in.</span>
            <Button size="sm" variant="danger" disabled={saving} onClick={() => save(false)}>
              {saving ? "Saving..." : "Yes, make it optional"}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : required ? (
          <Button size="sm" variant="danger" disabled={saving} onClick={() => setConfirming(true)}>
            Make optional
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={saving} onClick={() => save(true)}>
            {saving ? "Saving..." : "Make required"}
          </Button>
        )}
      </div>
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
