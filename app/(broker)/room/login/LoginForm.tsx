"use client";

import { useEffect, useRef, useState } from "react";
import HumanCheck from "@/components/room/HumanCheck";

// Same credential check as the portal (POST /api/portal/login: email + password, verified e-mail, rate limit).
export default function LoginForm({ notice }: { notice: { ok: boolean; text: string } | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // the server asks for the check after repeated failures, and hands over the key with that answer
  const [humanKey, setHumanKey] = useState("");
  const [humanToken, setHumanToken] = useState("");
  const [humanRound, setHumanRound] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (waiting && humanToken) { setWaiting(false); form.current?.requestSubmit(); }
  }, [waiting, humanToken]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, remember, ...(needCode ? { code } : {}), ...(humanToken ? { turnstileToken: humanToken } : {}) }),
      });
      if (humanToken) { setHumanToken(""); setHumanRound((r) => r + 1); }
      if (res.ok) {
        window.location.assign("/room");
        return;
      }
      const body = await res.json().catch(() => null);
      if (body?.code === "HUMAN_CHECK_REQUIRED") { setHumanKey(body.siteKey); setWaiting(true); setError("Checking your browser…"); return; }
      if (body?.code === "TWO_FACTOR_REQUIRED") { setNeedCode(true); setError(""); return; }
      if (body?.code === "TWO_FACTOR_INVALID") { setError("Wrong code. Try the next one."); return; }
      setError(res.status === 401 ? "Wrong email or password." : res.status === 429 ? "Too many attempts. Try again in a few minutes." : res.status === 403 ? "Verify your email first. Check your inbox." : body?.error ?? "Sign-in failed.");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={form} className="r-auth-box" onSubmit={submit}>
      <div>
        <h1>Sign in to your client portal</h1>
        <div style={{ fontSize: 13, color: "var(--r-muted)", marginTop: 6 }}>Use the email you registered with.</div>
      </div>
      {notice ? <div className={notice.ok ? "r-okmsg" : "r-error"} role="status">{notice.text}</div> : null}
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
      {humanKey ? <HumanCheck siteKey={humanKey} round={humanRound} onToken={setHumanToken} /> : null}
      {error ? <div className="r-error" role="alert">{error}</div> : null}
      <button className="r-btn" type="submit" disabled={busy} style={{ padding: "12px 0", fontSize: 14 }}>{busy ? "Signing in…" : "Sign in"}</button>
      <div style={{ borderTop: "1px solid var(--r-line)", paddingTop: 18, fontSize: 13, color: "var(--r-text-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>New client?</span>
        <a href="/register" style={{ fontWeight: 600 }}>Open an account</a>
      </div>
    </form>
  );
}
