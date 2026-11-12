"use client";

import { useEffect, useRef, useState } from "react";
import HumanCheck from "@/components/room/HumanCheck";

// Same credential check as the portal (POST /api/portal/login: email + password, verified e-mail, rate limit).
// googleOn: "Continue with Google" under Sign in (GOOGLE_LOGIN_ENABLED). googleCode: Google said who it is, and the
// client has 2FA on, so only the authenticator code is asked (POST /api/auth/google/2fa).
export default function LoginForm({ notice, googleOn = false, googleCode = false }: { notice: { ok: boolean; text: string } | null; googleOn?: boolean; googleCode?: boolean }) {
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

  async function submitGoogleCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/google/2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      if (res.ok) { window.location.assign("/room"); return; }
      const body = await res.json().catch(() => null);
      if (body?.code === "EXPIRED") { window.location.assign("/login?google=expired"); return; }
      setError(body?.error ?? "Sign-in failed.");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (googleCode) {
    return (
      <form className="r-auth-box" onSubmit={submitGoogleCode}>
        <div>
          <h1>Sign in to your client portal</h1>
          <div style={{ fontSize: 13, color: "var(--r-muted)", marginTop: 6 }}>Enter the code from your authenticator app.</div>
        </div>
        <div className="r-field">
          <label htmlFor="code">Authenticator code</label>
          <input id="code" className="r-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
        {error ? <div className="r-error" role="alert">{error}</div> : null}
        <button className="r-btn" type="submit" disabled={busy} style={{ padding: "12px 0", fontSize: 14 }}>{busy ? "Signing in…" : "Continue"}</button>
        <a href="/login" style={{ fontSize: 13, textAlign: "center" }}>Use a different sign-in</a>
      </form>
    );
  }

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
      {googleOn ? (
        <>
          <div className="r-or" aria-hidden="true">or</div>
          <a className="r-google-btn" href={remember ? "/api/auth/google/start" : "/api/auth/google/start?remember=0"}>
            <GoogleG />
            <span>Continue with Google</span>
          </a>
        </>
      ) : null}
      <div style={{ borderTop: "1px solid var(--r-line)", paddingTop: 18, fontSize: 13, color: "var(--r-text-2)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>New client?</span>
        <a href="/register" style={{ fontWeight: 600 }}>Open an account</a>
      </div>
    </form>
  );
}

// Google's own "G" mark, unchanged (Sign in with Google branding guidelines).
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
