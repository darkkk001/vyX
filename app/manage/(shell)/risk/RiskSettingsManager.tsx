"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Modal, ModalActions } from "@/components/ui/Modal";

export type RiskSettings = {
  dealingMode: boolean;
  totalExposureLimit: string | null;
  maxOpenPositionsPerAccount: number | null;
  smartDealerAcceptPct: string | null;
  smartDealerRejectPct: string | null;
};

async function patchRisk(body: Record<string, unknown>) {
  const response = await fetch("/api/manage/risk", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "update failed");
  return data as RiskSettings;
}

export default function RiskSettingsManager({ initial }: { initial: RiskSettings }) {
  const router = useRouter();
  const [dealingMode, setDealingMode] = useState(initial.dealingMode);
  const [confirmingDealing, setConfirmingDealing] = useState(false);
  const [dealingBusy, setDealingBusy] = useState(false);
  const [dealingError, setDealingError] = useState<string | null>(null);

  const [totalExposureLimit, setTotalExposureLimit] = useState(initial.totalExposureLimit ?? "");
  const [maxOpenPositionsPerAccount, setMaxOpenPositionsPerAccount] = useState(
    initial.maxOpenPositionsPerAccount != null ? String(initial.maxOpenPositionsPerAccount) : ""
  );
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsSaved, setLimitsSaved] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const [smartDealerAcceptPct, setSmartDealerAcceptPct] = useState(initial.smartDealerAcceptPct ?? "");
  const [smartDealerRejectPct, setSmartDealerRejectPct] = useState(initial.smartDealerRejectPct ?? "");
  const [smartDealerSaving, setSmartDealerSaving] = useState(false);
  const [smartDealerSaved, setSmartDealerSaved] = useState(false);
  const [smartDealerError, setSmartDealerError] = useState<string | null>(null);

  async function toggleDealingMode() {
    setDealingBusy(true);
    setDealingError(null);
    try {
      const result = await patchRisk({ dealingMode: !dealingMode });
      setDealingMode(result.dealingMode);
      setConfirmingDealing(false);
      router.refresh();
    } catch (e) {
      setDealingError(e instanceof Error ? e.message : "update failed");
    } finally {
      setDealingBusy(false);
    }
  }

  async function saveLimits(e: React.FormEvent) {
    e.preventDefault();
    setLimitsSaving(true);
    setLimitsSaved(false);
    setLimitsError(null);
    try {
      const result = await patchRisk({
        totalExposureLimit: totalExposureLimit.trim() === "" ? null : totalExposureLimit.trim(),
        maxOpenPositionsPerAccount: maxOpenPositionsPerAccount.trim() === "" ? null : maxOpenPositionsPerAccount.trim(),
      });
      setTotalExposureLimit(result.totalExposureLimit ?? "");
      setMaxOpenPositionsPerAccount(result.maxOpenPositionsPerAccount != null ? String(result.maxOpenPositionsPerAccount) : "");
      setLimitsSaved(true);
      router.refresh();
    } catch (e) {
      setLimitsError(e instanceof Error ? e.message : "update failed");
    } finally {
      setLimitsSaving(false);
    }
  }

  async function saveSmartDealer(e: React.FormEvent) {
    e.preventDefault();
    setSmartDealerSaving(true);
    setSmartDealerSaved(false);
    setSmartDealerError(null);
    try {
      const result = await patchRisk({
        smartDealerAcceptPct: smartDealerAcceptPct.trim() === "" ? null : smartDealerAcceptPct.trim(),
        smartDealerRejectPct: smartDealerRejectPct.trim() === "" ? null : smartDealerRejectPct.trim(),
      });
      setSmartDealerAcceptPct(result.smartDealerAcceptPct ?? "");
      setSmartDealerRejectPct(result.smartDealerRejectPct ?? "");
      setSmartDealerSaved(true);
      router.refresh();
    } catch (e) {
      setSmartDealerError(e instanceof Error ? e.message : "update failed");
    } finally {
      setSmartDealerSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Dealing mode">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Badge tone={dealingMode ? "accent" : "neutral"}>{dealingMode ? "DEALING MODE ON" : "Instant execution"}</Badge>
            <p className="mt-2 text-sm text-[var(--text-3)]">
              {dealingMode
                ? "New MARKET orders wait for manual Accept/Reject in the Dealing queue instead of filling instantly."
                : "New MARKET orders fill instantly, as normal. Limit/Stop orders are unaffected either way."}
            </p>
          </div>
          <Button size="sm" variant={dealingMode ? "danger" : "primary"} onClick={() => setConfirmingDealing(true)}>
            {dealingMode ? "Turn off" : "Turn on"}
          </Button>
        </div>
        {dealingError ? (
          <div className="mt-3">
            <Alert tone="danger">{dealingError}</Alert>
          </div>
        ) : null}

        {dealingMode ? (
          <form onSubmit={saveSmartDealer} className="mt-4 flex flex-col gap-3 border-t border-[var(--border)] pt-4">
            <p className="text-sm text-[var(--text-2)]">
              Smart Dealer -- auto-decide an order the moment it&apos;s submitted, before it ever reaches a human. Blank = fully manual (today&apos;s behavior).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="Auto-accept within (%)">
                <Input
                  type="text"
                  inputMode="decimal"
                  mono
                  placeholder="off"
                  value={smartDealerAcceptPct}
                  onChange={(e) => { setSmartDealerAcceptPct(e.target.value); setSmartDealerSaved(false); }}
                  className="w-28"
                />
              </FormField>
              <FormField label="Auto-reject beyond (%)">
                <Input
                  type="text"
                  inputMode="decimal"
                  mono
                  placeholder="off"
                  value={smartDealerRejectPct}
                  onChange={(e) => { setSmartDealerRejectPct(e.target.value); setSmartDealerSaved(false); }}
                  className="w-28"
                />
              </FormField>
              <Button type="submit" size="sm" disabled={smartDealerSaving}>
                {smartDealerSaving ? "Saving..." : "Save"}
              </Button>
              {smartDealerSaved ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
            </div>
            {smartDealerError ? <Alert tone="danger">{smartDealerError}</Alert> : null}
          </form>
        ) : null}
      </Card>

      <Modal open={confirmingDealing} onClose={() => setConfirmingDealing(false)} title={dealingMode ? "Confirm turn off dealing mode" : "Confirm turn on dealing mode"}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            {dealingMode
              ? "New MARKET orders will fill instantly again immediately."
              : "New MARKET orders will queue for manual Accept/Reject in the Dealing queue until turned off. Limit/Stop orders are unaffected."}
          </p>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirmingDealing(false)}>
              Cancel
            </Button>
            <Button variant={dealingMode ? "danger" : "primary"} disabled={dealingBusy} onClick={toggleDealingMode}>
              {dealingBusy ? "Working..." : dealingMode ? "Confirm: turn off" : "Confirm: turn on"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Card title="Exposure & position limits">
        <form onSubmit={saveLimits} className="flex flex-col gap-4">
          <FormField label="Total broker exposure limit (lots, blank = no limit)">
            <Input
              type="text"
              inputMode="decimal"
              mono
              placeholder="no limit"
              value={totalExposureLimit}
              onChange={(e) => {
                setTotalExposureLimit(e.target.value);
                setLimitsSaved(false);
              }}
              className="max-w-xs"
            />
          </FormField>
          <FormField label="Max open positions per account (blank = no limit)">
            <Input
              type="text"
              inputMode="numeric"
              mono
              placeholder="no limit"
              value={maxOpenPositionsPerAccount}
              onChange={(e) => {
                setMaxOpenPositionsPerAccount(e.target.value);
                setLimitsSaved(false);
              }}
              className="max-w-xs"
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={limitsSaving}>
              {limitsSaving ? "Saving..." : "Save"}
            </Button>
            {limitsSaved ? <span className="text-sm text-[var(--buy)]">Saved</span> : null}
          </div>
          {limitsError ? <Alert tone="danger">{limitsError}</Alert> : null}
        </form>
      </Card>
    </div>
  );
}
