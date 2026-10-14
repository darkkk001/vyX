"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "../PortalAuth.module.css";
import ResendVerification from "../ResendVerification";
import PasswordField from "@/components/PasswordField";
import { plainError } from "@/lib/plain-error";

export default function LoginForm({ brokerName, brokerLogoUrl }: { brokerName: string; brokerLogoUrl: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const verifyParam = searchParams.get("verify");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Login refused because the address is not verified yet: offer a new link.
  const [needsVerification, setNeedsVerification] = useState(false);
  const [showVerifyNotice, setShowVerifyNotice] = useState(verifyParam === "success");
  const [showVerifyInvalid, setShowVerifyInvalid] = useState(verifyParam === "invalid");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNeedsVerification(false);

    const response = await fetch("/api/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);

    if (!response.ok) {
      setError(plainError(body, "Sign-in failed. Try again."));
      setNeedsVerification(response.status === 403 && typeof body.error === "string" && body.error.includes("verify your email"));
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
            <PasswordField
              id="password"
              className={styles.input}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error ? <div className={styles.formError}>{error}</div> : null}
          {needsVerification || showVerifyInvalid ? <ResendVerification email={email} /> : null}

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
