"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "../PortalAuth.module.css";

export default function ForgotPasswordForm({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string | null }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/portal/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "something went wrong, please try again");
      return;
    }

    // Same constant-shape success regardless of whether the email exists
    // -- matches POST /api/portal/forgot-password's own response, doesn't
    // let this form enumerate registered emails either.
    setSent(true);
  }

  if (sent) {
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
              If an account exists for <strong style={{ color: "var(--text-1)" }}>{email}</strong>, we&apos;ve sent a link to reset your password.
            </p>
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
        <h1 className={styles.title}>Forgot password?</h1>
        <p className={styles.subtitle}>Enter your email and we&apos;ll send you a link to reset your password.</p>

        <form onSubmit={handleSubmit}>
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

          {error ? <div className={styles.formError}>{error}</div> : null}

          <button type="submit" className={styles.btnPrimary} disabled={submitting}>
            {submitting ? "Sending…" : "Send reset link"}
          </button>
        </form>

        <div className={styles.footer} style={{ justifyContent: "center" }}>
          <Link href="/portal/login">Back to login</Link>
        </div>
      </div>
    </div>
  );
}
