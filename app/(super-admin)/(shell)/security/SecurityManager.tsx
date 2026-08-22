"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";

// Same enable/confirm/disable flow WebTrader.tsx's own Security modal
// already uses for a trader's 2FA (tradeApi.setupTwoFactor/
// confirmTwoFactor/disableTwoFactor), scoped to AdminUser via the
// app/api/admin/two-factor/* routes instead.
export default function SecurityManager({ initialTwoFactorEnabled }: { initialTwoFactorEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialTwoFactorEnabled);
  const [setupData, setSetupData] = useState<{ secret: string; qrCodeDataUri: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function startSetup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/two-factor/setup", { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "failed to start 2FA setup");
      return;
    }
    const body = await res.json();
    setSetupData({ secret: body.secret, qrCodeDataUri: body.qrCodeDataUri });
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/two-factor/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: confirmCode }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "invalid code");
      return;
    }
    setEnabled(true);
    setSetupData(null);
    setConfirmCode("");
    setNotice("Two-factor authentication is now enabled.");
  }

  async function disableSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/two-factor/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: disablePassword }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "failed to disable 2FA");
      return;
    }
    setEnabled(false);
    setDisablePassword("");
    setNotice("Two-factor authentication is now disabled.");
  }

  return (
    <Card
      title="Two-factor authentication"
      description="Adds a 6-digit code from an authenticator app on top of your password."
      action={<Badge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Not enabled"}</Badge>}
    >
      {notice ? (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {enabled ? (
        <form onSubmit={disableSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-3)]">Enter your password to turn it off.</p>
          <FormField label="Password">
            <PasswordInput
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </FormField>
          <Button type="submit" variant="danger" loading={busy} className="w-fit">
            Disable 2FA
          </Button>
        </form>
      ) : setupData ? (
        <form onSubmit={confirmSetup} className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-3)]">
            Scan this with your authenticator app, or enter the key manually, then confirm with a code.
          </p>
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setupData.qrCodeDataUri} alt="2FA setup QR code" width={160} height={160} className="rounded-md" />
          </div>
          <p className="break-all text-center font-mono text-xs text-[var(--text-3)]">{setupData.secret}</p>
          <FormField label="6-digit code">
            <Input
              inputMode="numeric"
              placeholder="123456"
              maxLength={6}
              mono
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, ""))}
              required
              className="text-center tracking-[4px]"
            />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setSetupData(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={confirmCode.length !== 6}>
              Confirm
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <p className="mb-3 text-sm text-[var(--text-3)]">Not enabled yet -- this account has no extra protection beyond your password.</p>
          <Button type="button" variant="primary" loading={busy} onClick={startSetup} className="w-fit">
            Enable 2FA
          </Button>
        </div>
      )}
    </Card>
  );
}
