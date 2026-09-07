"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "../PortalAuth.module.css";

export default function LoginForm({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const verifyParam = searchParams.get("verify");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showVerifyNotice, setShowVerifyNotice] = useState(verifyParam === "success");
  const [showVerifyInvalid, setShowVerifyInvalid] = useState(verifyParam === "invalid");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);

    if (!response.ok) {
      setError(body.error ?? "login failed");
      return;
    }

    router.push("/portal");
    router.refresh();
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
        <h1 className={styles.title}>Log in</h1>
        <p className={styles.subtitle}>Access your {brokerName} client portal.</p>

        {showVerifyNotice ? (
          <div className={styles.formNotice}>
            Email verified. You can log in now.
          </div>
        ) : null}
        {showVerifyInvalid ? (
          <div className={styles.formError}>
            That verification link is invalid or has expired.
          </div>
        ) : null}

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
              onChange={(e) => { setEmail(e.target.value); setShowVerifyNotice(false); setShowVerifyInvalid(false); }}
              required
            />
          </div>
          <div className={styles.field}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label className={styles.fieldLabel} style={{ marginBottom: 0 }} htmlFor="password">Password</label>
              <Link href="/portal/forgot-password" style={{ fontSize: 11, color: "var(--text-3)" }}>Forgot password?</Link>
            </div>
            <div className={styles.passwordWrap}>
              <input
                id="password"
                className={styles.input}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
            {submitting ? "Logging in…" : "Log in"}
          </button>
        </form>

        <div className={styles.footer} style={{ justifyContent: "center" }}>
          <span style={{ color: "var(--text-3)" }}>New here?</span>
          <Link href="/portal/register">Create an account</Link>
        </div>
      </div>
    </div>
  );
}
