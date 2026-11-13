"use client";

import { useState } from "react";
import { useHumanCheck } from "@/components/room/HumanCheck";

// Same request as the portal form (POST /api/portal/forgot-password): the answer has one shape whether or not the
// e-mail exists, so the form never tells which addresses are registered.
export default function RoomForgotForm({ humanKey = null }: { humanKey?: string | null }) {
  const human = useHumanCheck(humanKey);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const turnstileToken = await human.take();
      const res = await fetch("/api/portal/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, ...(turnstileToken ? { turnstileToken } : {}) }) });
      if (res.ok) { setSent(true); return; }
      const body = await res.json().catch(() => null);
      setError(body?.code === "HUMAN_CHECK_REQUIRED" ? "Could not check your browser. Press Send reset link again." : res.status === 429 ? "Too many attempts. Try again in a few minutes." : body?.error ?? "Something went wrong. Try again.");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="r-auth-box">
        <div>
          <h1>Check your email</h1>
          <div style={{ fontSize: 13, color: "var(--r-muted)", marginTop: 6, lineHeight: 1.6 }}>
            If an account exists for <strong style={{ color: "var(--r-text)" }}>{email}</strong>, we sent a link to reset your password.
          </div>
        </div>
        <a className="r-btn" href="/login" style={{ padding: "12px 0", fontSize: 14, textAlign: "center" }}>Back to sign in</a>
      </div>
    );
  }

  return (
    <form className="r-auth-box" onSubmit={submit}>
      <div>
        <h1>Forgot password?</h1>
        <div style={{ fontSize: 13, color: "var(--r-muted)", marginTop: 6 }}>Enter your email and we will send you a reset link.</div>
      </div>
      <div className="r-field">
        <label htmlFor="email">Email</label>
        <input id="email" className="r-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {human.el}
      {error ? <div className="r-error" role="alert">{error}</div> : null}
      <button className="r-btn" type="submit" disabled={busy} style={{ padding: "12px 0", fontSize: 14 }}>{busy ? "Sending…" : "Send reset link"}</button>
      <div style={{ borderTop: "1px solid var(--r-line)", paddingTop: 18, fontSize: 13, color: "var(--r-text-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>Remembered it?</span>
        <a href="/login" style={{ fontWeight: 600 }}>Sign in</a>
      </div>
    </form>
  );
}
