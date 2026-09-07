"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "../PortalAuth.module.css";

export default function RegisterForm({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set once registration succeeds -- swaps the form for a "check your
  // email" state rather than navigating anywhere. There's no page to
  // land on yet besides /portal/login, and the whole point of this step
  // is "go read your email first," not "browse the site."
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [devVerifyUrl, setDevVerifyUrl] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/portal/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, fullName }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);

    if (!response.ok) {
      setError(body.error ?? "registration failed");
      return;
    }

    setRegisteredEmail(email);
    // Mock-adapter-only field (lib/email/adapter.ts) -- never present once
    // a real provider is configured, or in production regardless.
    setDevVerifyUrl(body.devVerifyUrl ?? null);
  }

  if (registeredEmail) {
    return (
      <div className={styles.root}>
        <div className={styles.mesh} />
        <div className={styles.card}>
          <Link href="/" className={styles.brand}>
            {brokerLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brokerLogoUrl} alt={`${brokerName} logo`} className={styles.logo} />
            ) : null}
            <span className={styles.brandName}>{brokerName}</span>
          </Link>
          <div className={styles.checkEmail}>
            <div className={styles.checkEmailIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M4 6l8 7 8-7" /></svg>
            </div>
            <h1 className={styles.title}>Check your email</h1>
            <p className={styles.subtitle}>
              We sent a verification link to <strong style={{ color: "var(--text-1)" }}>{registeredEmail}</strong>. Click it to finish setting up your account.
            </p>
            {devVerifyUrl ? (
              <p className={styles.formNotice} style={{ wordBreak: "break-all", textAlign: "left" }}>
                Dev only (no email provider configured yet): <a href={devVerifyUrl} style={{ color: "var(--accent)" }}>{devVerifyUrl}</a>
              </p>
            ) : null}
          </div>
          <div className={styles.footer} style={{ justifyContent: "center" }}>
            <Link href="/portal/login">Back to login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.mesh} />
      <div className={styles.card}>
        <Link href="/" className={styles.brand}>
          {brokerLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brokerLogoUrl} alt={`${brokerName} logo`} className={styles.logo} />
          ) : null}
          <span className={styles.brandName}>{brokerName}</span>
        </Link>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>Manage your {brokerName} trading accounts, deposits, and KYC in one place.</p>

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="fullName">Full name</label>
            <input
              id="fullName"
              className={styles.input}
              type="text"
              autoComplete="name"
              placeholder="Jane Trader"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="email">Email</label>
            <input
              id="email"
              className={styles.input}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="password">Password</label>
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

          {error ? <div className={styles.formError}>{error}</div> : null}

          <button type="submit" className={styles.btnPrimary} disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <div className={styles.footer}>
          <span style={{ color: "var(--text-3)" }}>Already have an account?</span>
          <Link href="/portal/login">Log in</Link>
        </div>
      </div>
    </div>
  );
}
