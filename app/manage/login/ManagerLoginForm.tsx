"use client";

import { useState } from "react";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Checkbox } from "@/components/ui/Checkbox";
import TwoPanelAuthShell, { twoPanelAuthShellStyles as styles } from "@/components/admin/TwoPanelAuthShell";

type View = "signin" | "twoFactor" | "forgot" | "forgotSent" | "success";

// Portable core -- no next/navigation dependency, same "extract the
// router dependency out" split as TradeLoginForm.tsx/NextTradeLoginForm.tsx
// (see that pair's own comments). The website keeps using
// NextManagerLoginForm.tsx, which supplies the router-based
// onAuthenticated default; manager-shell (the bundled Manager terminal)
// instead passes a callback that just flips local state, since the
// document has no real URL of its own to navigate to.
export default function ManagerLoginForm({
  brokerName,
  logoUrl,
  onAuthenticated,
}: {
  brokerName: string;
  logoUrl: string | null;
  onAuthenticated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [view, setView] = useState<View>("signin");

  // Forgot-password -- an in-app request instead of a mailto: link (which
  // does nothing if the device has no email client configured, and
  // leaves no record Super Admin can act on). Shows up as a
  // Notification in app/(super-admin)/(shell)/notifications with a
  // "Reset password" action.
  const [forgotNote, setForgotNote] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);

  // Two-factor step -- mirrors TradeLoginForm.tsx's own pendingToken
  // handoff (see that component's comment) for the trader login, ported
  // here for Manager/Broker Admin/Support (Phase 1 trust pack). useBackupCode
  // toggles which field the single input below actually submits -- POST
  // /api/manage/login/verify-2fa accepts either `code` or `backupCode`,
  // never both at once.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter both your email and password.");
      return;
    }
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }

    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/manage/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, remember }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "login failed");
      return;
    }

    const body = await response.json();
    if (body.requiresTwoFactor) {
      setPendingToken(body.pendingToken);
      setView("twoFactor");
      return;
    }

    // Brief real confirmation before the redirect, not a fake delay --
    // matches how the credential check itself already took a moment.
    setView("success");
    setTimeout(onAuthenticated, 500);
  }

  async function handleVerifyTwoFactor(event: React.FormEvent) {
    event.preventDefault();
    if (!pendingToken) return;
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/manage/login/verify-2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingToken,
        remember,
        ...(useBackupCode ? { backupCode: twoFactorCode } : { code: twoFactorCode }),
      }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "verification failed");
      return;
    }

    setView("success");
    setTimeout(onAuthenticated, 500);
  }

  async function handleForgotPassword(event: React.FormEvent) {
    event.preventDefault();
    setForgotSubmitting(true);
    await fetch("/api/admin/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), note: forgotNote.trim() }),
    }).catch(() => {});
    setForgotSubmitting(false);
    setView("forgotSent");
  }

  return (
    <TwoPanelAuthShell brandName={`${brokerName} Backoffice`} brandSubtitle="Broker management console" logoUrl={logoUrl}>
      {view === "success" ? (
        <div className={styles.step}>
          <div className={styles.successIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">You&apos;re in</h1>
          <p className="mt-1.5 text-[12.5px] text-[var(--text-3)]">Redirecting you to the dashboard…</p>
        </div>
      ) : view === "twoFactor" ? (
        <form onSubmit={handleVerifyTwoFactor} className={styles.step}>
          <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Two-factor verification</h1>
          <p className="mb-7 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--text-3)]">
            {useBackupCode ? "Enter one of your saved backup codes." : "Enter the 6-digit code from your authenticator app."}
          </p>
          {error ? (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
          <div className="mb-6">
            <FormField label={useBackupCode ? "Backup code" : "6-digit code"}>
              <Input
                inputMode={useBackupCode ? "text" : "numeric"}
                autoComplete="one-time-code"
                placeholder={useBackupCode ? "XXXX-XXXX" : "123456"}
                maxLength={useBackupCode ? 9 : 6}
                mono
                autoFocus
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(useBackupCode ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))}
                required
                className="text-center tracking-[4px]"
              />
            </FormField>
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={useBackupCode ? twoFactorCode.length < 8 : twoFactorCode.length !== 6}
            className="w-full"
          >
            {submitting ? "Verifying..." : "Verify"}
          </Button>
          <button
            type="button"
            className="mt-3 w-full text-center text-[11.5px] font-medium text-[var(--accent)] hover:underline"
            onClick={() => {
              setUseBackupCode((v) => !v);
              setTwoFactorCode("");
              setError(null);
            }}
          >
            {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
          </button>
        </form>
      ) : view === "forgotSent" ? (
        <div className={styles.step}>
          <div className={styles.successIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Request sent</h1>
          <p className="mt-1.5 text-[12.5px] text-[var(--text-3)]">
            If that email belongs to a backoffice account, Super Admin has been notified and will reset your password
            directly.
          </p>
          <Button type="button" variant="secondary" className="mt-5 w-full" onClick={() => setView("signin")}>
            Back to sign in
          </Button>
        </div>
      ) : view === "forgot" ? (
        <form onSubmit={handleForgotPassword} className={styles.step}>
          <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Forgot password</h1>
          <p className="mb-7 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--text-3)]">
            Enter your backoffice email and Super Admin will reset your password for you.
          </p>
          <div className="mb-4">
            <FormField label="Email address" htmlFor="forgot-email">
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                placeholder="you@broker.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </FormField>
          </div>
          <div className="mb-6">
            <FormField label="Note (optional)" htmlFor="forgot-note">
              <Input
                id="forgot-note"
                placeholder="Anything that helps Super Admin verify it's you"
                value={forgotNote}
                onChange={(e) => setForgotNote(e.target.value)}
              />
            </FormField>
          </div>
          <Button type="submit" variant="primary" loading={forgotSubmitting} disabled={!email.trim()} className="w-full">
            {forgotSubmitting ? "Sending..." : "Send request"}
          </Button>
          <button
            type="button"
            className="mt-3 w-full text-center text-[11.5px] font-medium text-[var(--accent)] hover:underline"
            onClick={() => setView("signin")}
          >
            Back to sign in
          </button>
        </form>
      ) : (
        <form onSubmit={handleSubmit} className={styles.step}>
          <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Sign in</h1>
          <p className="mb-7 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--text-3)]">Access your broker&apos;s management console.</p>

          {error ? (
            <div className="mb-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <div className="mb-4">
            <FormField label="Email address" htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@broker.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
          </div>

          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="password" className="text-[11px] text-[var(--text-3)]">
                Password
              </label>
              <a
                onClick={() => setView("forgot")}
                className="cursor-pointer text-[11.5px] font-medium text-[var(--accent)] hover:underline"
              >
                Forgot password?
              </a>
            </div>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="mb-6">
            <Checkbox
              id="remember"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              label="Keep me signed in for 30 days"
            />
          </div>

          <Button type="submit" variant="primary" loading={submitting} className="w-full">
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      )}
    </TwoPanelAuthShell>
  );
}
