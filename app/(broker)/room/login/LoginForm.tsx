"use client";

import { useState } from "react";

// Same credential check as the portal (POST /api/portal/login: email + password, verified e-mail, rate limit).
export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember, ...(needCode ? { code } : {}) }),
      });
      if (res.ok) {
        window.location.assign("/room");
        return;
      }
      const body = await res.json().catch(() => null);
      if (body?.code === "TWO_FACTOR_REQUIRED") { setNeedCode(true); setError(""); return; }
      if (body?.code === "TWO_FACTOR_INVALID") { setError("Wrong code. Try the next one."); return; }
      setError(res.status === 401 ? "Wrong email or password." : res.status === 429 ? "Too many attempts. Try again in a minute." : res.status === 403 ? "Verify your email first. Check your inbox." : body?.error ?? "Sign-in failed.");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="r-auth-box" onSubmit={submit}>
      <div>
        <h1>Sign in</h1>
        <div style={{ fontSize: 13, color: "var(--r-muted)", marginTop: 6 }}>Use the email registered with your broker.</div>
      </div>
      <div className="r-field">
        <label htmlFor="email">Email</label>
        <input id="email" className="r-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="r-field">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label htmlFor="pw" className="r-flabel">Password</label>
          <a href="/portal/forgot-password" style={{ fontSize: 12, fontWeight: 500 }}>Forgot password?</a>
        </div>
        <input id="pw" className="r-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {needCode ? (
        <div className="r-field">
          <label htmlFor="code">Authenticator code</label>
          <input id="code" className="r-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
      ) : null}
      <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--r-text-2)", cursor: "pointer" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--r-accent)" }} />
        Keep me signed in on this device
      </label>
      {error ? <div className="r-error" role="alert">{error}</div> : null}
      <button className="r-btn" type="submit" disabled={busy} style={{ padding: "12px 0", fontSize: 14 }}>{busy ? "Signing in…" : "Sign in"}</button>
      <div style={{ borderTop: "1px solid var(--r-line)", paddingTop: 18, fontSize: 13, color: "var(--r-text-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>New client?</span>
        <a href="/room/register" style={{ fontWeight: 600 }}>Open an account</a>
      </div>
    </form>
  );
}
