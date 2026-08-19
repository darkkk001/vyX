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
  tradingHalted: boolean;
  dealingMode: boolean;
  totalExposureLimit: string | null;
  maxOpenPositionsPerAccount: number | null;
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
  const [tradingHalted, setTradingHalted] = useState(initial.tradingHalted);
  const [confirmingHalt, setConfirmingHalt] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
  const [haltError, setHaltError] = useState<string | null>(null);

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

  async function toggleHalt() {
    setHaltBusy(true);
    setHaltError(null);
    try {
      const result = await patchRisk({ tradingHalted: !tradingHalted });
      setTradingHalted(result.tradingHalted);
      setConfirmingHalt(false);
      router.refresh();
    } catch (e) {
      setHaltError(e instanceof Error ? e.message : "update failed");
    } finally {
      setHaltBusy(false);
    }
  }

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

  return (
    <div className="flex flex-col gap-6">
      <Card title="Emergency trading halt">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Badge tone={tradingHalted ? "danger" : "success"}>
              {tradingHalted ? "HALTED" : "Trading active"}
            </Badge>
            <p className="mt-2 text-sm text-[var(--text-3)]">
              {tradingHalted
                ? "All new orders and manual position opens are being rejected for this broker."
                : "New orders are being accepted normally."}
            </p>
          </div>
          <Button size="sm" variant={tradingHalted ? "primary" : "danger"} onClick={() => setConfirmingHalt(true)}>
            {tradingHalted ? "Resume trading" : "Halt trading"}
          </Button>
        </div>
        {haltError ? (
          <div className="mt-3">
            <Alert tone="danger">{haltError}</Alert>
          </div>
        ) : null}
      </Card>

      <Modal open={confirmingHalt} onClose={() => setConfirmingHalt(false)} title={tradingHalted ? "Confirm resume trading" : "Confirm halt trading"}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            {tradingHalted
              ? "New orders and manual position opens will be accepted again immediately."
              : "New orders and manual position opens will be rejected for this broker until resumed. Existing open positions are untouched."}
          </p>
          <ModalActions>
            <Button variant="ghost" onClick={() => setConfirmingHalt(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={haltBusy} onClick={toggleHalt}>
              {haltBusy ? "Working..." : tradingHalted ? "Confirm: resume trading" : "Confirm: halt trading"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

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
