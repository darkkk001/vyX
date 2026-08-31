"use client";

import { useEffect, useState } from "react";
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
// app/api/admin/two-factor/* routes instead. Self-fetches its initial
// enabled/disabled state from /api/admin/two-factor/status instead of
// receiving it as a server-rendered prop -- the website (both Super
// Admin's and Manager's own /security page) and any bundled desktop
// shell (no Server Component of its own) all share this one component
// and these same routes now (Phase 1 trust pack widened them from
// SUPER_ADMIN-only to every admin role).
//
// forceSetup renders a persistent banner instead of the normal
// "not enabled" copy -- app/manage/(shell)/layout.tsx redirects here
// with ?setupRequired=1 when Broker.requireAdmin2fa is on and this admin
// hasn't set 2FA up yet; the banner is the only difference, the actual
// setup flow below is identical either way (nothing here can dismiss the
// requirement except actually completing setup -- the layout's own
// redirect keeps re-triggering on every other page until then).
type AdminSessionRow = { sessionId: string; userAgent: string | null; ip: string | null; createdAt: string; current: boolean };

export default function SecurityManager({ forceSetup = false }: { forceSetup?: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [unusedBackupCodes, setUnusedBackupCodes] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<{ secret: string; qrCodeDataUri: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Phase 1 trust pack §2 -- session list/revoke, same shape WebTrader.tsx's
  // own Security modal already has for traders (tradeApi's
  // listSessions/revokeSession), scoped to AdminUser via app/api/admin/
  // sessions/* instead.
  const [sessions, setSessions] = useState<AdminSessionRow[] | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

  function refreshStatus() {
    fetch("/api/admin/two-factor/status")
      .then((r) => r.json())
      .then((d: { enabled: boolean; unusedBackupCodes: number }) => {
        setEnabled(d.enabled);
        setUnusedBackupCodes(d.unusedBackupCodes);
      })
      .catch(() => setLoadError("failed to load"));
  }

  function refreshSessions() {
    fetch("/api/admin/sessions")
      .then((r) => r.json())
      .then((rows: AdminSessionRow[]) => setSessions(rows))
      .catch(() => setSessions([]));
  }

  useEffect(refreshStatus, []);
  useEffect(refreshSessions, []);

  async function revokeSessionRow(sessionId: string) {
    setRevokingSessionId(sessionId);
    await fetch(`/api/admin/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    setRevokingSessionId(null);
    refreshSessions();
  }

  async function signOutEverywhereElse() {
    if (!sessions) return;
    setBusy(true);
    await Promise.all(
      sessions.filter((s) => !s.current).map((s) => fetch(`/api/admin/sessions/${s.sessionId}`, { method: "DELETE" }))
    ).catch(() => {});
    setBusy(false);
    setNotice("Signed out of every other session.");
    refreshSessions();
  }

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
    const body = await res.json();
    setEnabled(true);
    setSetupData(null);
    setConfirmCode("");
    setNewBackupCodes(body.backupCodes ?? []);
    setUnusedBackupCodes((body.backupCodes ?? []).length);
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
    setUnusedBackupCodes(0);
    setDisablePassword("");
    setNotice("Two-factor authentication is now disabled.");
  }

  if (enabled === null) {
    return loadError ? <Alert tone="danger">{loadError}</Alert> : <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  // Shown exactly once, right after confirming setup -- these codes are
  // never retrievable again (only a bcrypt hash is stored, see
  // AdminBackupCode's schema comment), so this is the only chance to
  // save them.
  if (newBackupCodes) {
    return (
      <Card title="Save your backup codes" description="Each code works once, if you ever lose access to your authenticator app. They will not be shown again.">
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-2)] p-4 font-mono text-sm">
          {newBackupCodes.map((code) => (
            <span key={code} className="text-center text-[var(--text-1)]">{code}</span>
          ))}
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setNewBackupCodes(null);
            setNotice("Two-factor authentication is now enabled.");
          }}
        >
          I&apos;ve saved these codes
        </Button>
      </Card>
    );
  }

  return (
    <>
    <Card
      title="Two-factor authentication"
      description="Adds a 6-digit code from an authenticator app on top of your password."
      action={<Badge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Not enabled"}</Badge>}
    >
      {forceSetup && !enabled ? (
        <div className="mb-4">
          <Alert tone="warning">Your organization requires two-factor authentication. Set it up below to continue to the backoffice.</Alert>
        </div>
      ) : null}
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
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text-3)]">
            {unusedBackupCodes} unused backup code{unusedBackupCodes === 1 ? "" : "s"} remaining. Disabling and re-enabling issues a fresh set.
          </p>
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
        </div>
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
    <Card
      title="Active sessions"
      description="Every device currently signed into this backoffice login."
      action={
        sessions && sessions.filter((s) => !s.current).length > 0 ? (
          <Button type="button" variant="secondary" loading={busy} onClick={signOutEverywhereElse}>
            Sign out everywhere else
          </Button>
        ) : undefined
      }
    >
      {sessions === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No active sessions found.</p>
      ) : (
        <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
          {sessions.map((s) => (
            <div key={s.sessionId} className="flex items-center justify-between rounded-md border border-[var(--border-strong)] px-3 py-2">
              <div>
                <div className="text-xs text-[var(--text-1)]">
                  {s.userAgent ? s.userAgent.slice(0, 48) : "Unknown device"}
                  {s.current ? <span className="ml-1.5 text-[var(--buy)]">(this device)</span> : null}
                </div>
                <div className="font-mono text-[11px] text-[var(--text-3)]">
                  {s.ip ?? "unknown IP"} · {new Date(s.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={revokingSessionId === s.sessionId}
                onClick={() => revokeSessionRow(s.sessionId)}
              >
                {revokingSessionId === s.sessionId ? "…" : s.current ? "Log out" : "Revoke"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
    </>
  );
}
