"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Modal, ModalActions } from "@/components/ui/Modal";

// Extracted from RiskSettingsManager.tsx (same PATCH /api/manage/risk
// endpoint, same tradingHalted field) into its own page -- the target IA
// splits "Risk" (limits/dealing-mode config) from "Emergency Controls"
// (the kill switch), so this is a dedicated place for it rather than one
// more card buried on the Risk page.
async function patchTradingHalted(tradingHalted: boolean): Promise<{ tradingHalted: boolean }> {
  const response = await fetch("/api/manage/risk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tradingHalted }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "update failed");
  return data as { tradingHalted: boolean };
}

// Self-fetches its initial state from the already-existing
// /api/manage/risk route (which already returns tradingHalted alongside
// every other risk field) instead of receiving initialTradingHalted as
// a server-rendered prop -- both the website and a bundled
// manager-shell desktop app (no Server Component of its own) share this
// one path now.
export default function EmergencyControls() {
  const [tradingHalted, setTradingHalted] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manage/risk")
      .then((r) => r.json())
      .then((d: { tradingHalted: boolean }) => setTradingHalted(d.tradingHalted))
      .catch(() => setError("failed to load"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const result = await patchTradingHalted(!tradingHalted);
      setTradingHalted(result.tradingHalted);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  if (tradingHalted === null) {
    return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Emergency trading halt">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Badge tone={tradingHalted ? "danger" : "success"}>{tradingHalted ? "HALTED" : "Trading active"}</Badge>
            <p className="mt-2 text-sm text-[var(--text-3)]">
              {tradingHalted
                ? "All new orders and manual position opens are being rejected."
                : "New orders are being accepted normally."}
            </p>
          </div>
          <Button size="sm" variant={tradingHalted ? "primary" : "danger"} onClick={() => setConfirming(true)}>
            {tradingHalted ? "Resume trading" : "Halt trading"}
          </Button>
        </div>
        {error ? (
          <div className="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </Card>

      <Modal open={confirming} onClose={() => setConfirming(false)} title={tradingHalted ? "Confirm resume trading" : "Confirm halt trading"}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            {tradingHalted
              ? "New orders and manual position opens will be accepted again immediately."
              : "New orders and manual position opens will be rejected until resumed. Existing open positions are untouched."}
          </p>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={toggle}>
              {busy ? "Working..." : tradingHalted ? "Confirm: resume trading" : "Confirm: halt trading"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}
