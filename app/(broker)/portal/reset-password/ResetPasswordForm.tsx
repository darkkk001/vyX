"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "../PortalAuth.module.css";

export default function ResetPasswordForm({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string | null }) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError("This reset link is invalid or has expired. Request a new one.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setSubmitting(true);
    const response = await fetch("/api/portal/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);

    if (!response.ok) {
      setError(body.error ?? "failed to reset password");
      return;
    }

    setDone(true);
  }

  const brand = (
    <Link href="/" className={styles.brand}>
      {brokerLogoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brokerLogoUrl} alt={`${brokerName} logo`} className={styles.logo} />
      ) : null}
      <span className={styles.brandName}>{brokerName}</span>
    </Link>
  );

  if (done) {
    return (
      <div className={styles.root}>
        <div className={styles.mesh} />
        <div className={styles.card}>
          {brand}
          <div className={styles.checkEmail}>
            <div className={styles.checkEmailIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5" /></svg>
            </div>
            <h1 className={styles.title}>Password reset</h1>
            <p className={styles.subtitle}>Your password has been changed. You can now log in with your new password.</p>
          </div>
          <div className={styles.footer} style={{ justifyContent: "center" }}>
            <Link href="/portal/login">Go to login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.mesh} />
      <div className={styles.card}>
        {brand}
        <h1 className={styles.title}>Reset your password</h1>
        <p className={styles.subtitle}>Choose a new password for your {brokerName} account.</p>

        {!token ? (
          <div className={styles.formError}>This reset link is invalid or has expired. Request a new one from the login page.</div>
        ) : null}

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="password">New password</label>
            <div className={styles.passwordWrap}>
              <input
                id="password"
                className={styles.input}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
              <button type="button" className={styles.eyeBtn} onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"}>
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="confirmPassword">Confirm new password</label>
            <input
              id="confirmPassword"
              className={styles.input}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Repeat password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>

          {error ? <div className={styles.formError}>{error}</div> : null}

          <button type="submit" className={styles.btnPrimary} disabled={submitting || !token}>
            {submitting ? "Resetting…" : "Reset password"}
          </button>
        </form>

        <div className={styles.footer} style={{ justifyContent: "center" }}>
          <Link href="/portal/login">Back to login</Link>
        </div>
      </div>
    </div>
  );
}
