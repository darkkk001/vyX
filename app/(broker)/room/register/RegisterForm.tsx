"use client";

import { useState } from "react";

// POST /api/portal/register with the anti-bot fields: the hidden "website" honeypot and the signed form token.
export default function RegisterForm({ formToken, referral }: { formToken: string; referral: string }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [devLink, setDevLink] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) { setError("Use at least 8 characters with a letter and a number."); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, fullName, website, formToken, ...(referral ? { ref: referral } : {}) }) });
      const body = await res.json().catch(() => null);
      if (res.ok) { setSentTo(body?.email ?? email); setDevLink(body?.devVerifyUrl ?? ""); return; }
      setError(res.status === 409 ? "This email is already registered. Sign in instead." : res.status === 429 ? "Too many sign-ups. Try again later." : body?.code === "TOO_FAST" ? "Check your details and press Create account again." : body?.code === "FORM_EXPIRED" ? "This page has expired. Reload it and try again." : body?.error ?? "Could not create the account.");
    } catch {
      setError("No connection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="r-card" style={{ padding: 28, display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 24, fontWeight: 600 }}>Check your email</h1>
        <div style={{ fontSize: 13.5, color: "var(--r-text-2)", lineHeight: 1.6 }}>We sent a link to <span className="mono" style={{ color: "var(--r-text)" }}>{sentTo}</span>. Open it to confirm your email, then sign in.</div>
        {devLink ? <a href={devLink} style={{ fontSize: 12.5 }}>Open the link (test build)</a> : null}
        <a href="/login" style={{ fontSize: 13, fontWeight: 600 }}>Go to sign in</a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 24, fontWeight: 600 }}>Open an account</h1>
        <div style={{ fontSize: 13.5, color: "var(--r-text-2)", marginTop: 8, lineHeight: 1.6 }}>Start with your name and email. You can trade on a demo account right after you confirm your email.</div>
      </div>
      <div className="r-card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="r-field"><label htmlFor="fn">Full name</label><input id="fn" className="r-input" autoComplete="name" required maxLength={100} value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
        <div className="r-field"><label htmlFor="em">Email</label><input id="em" className="r-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="r-field"><label htmlFor="pw">Password</label><input id="pw" className="r-input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {/* honeypot: off screen for people, filled in by form bots (lib/portal-register-guard.ts) */}
        <div aria-hidden="true" style={{ position: "absolute", left: -10000, top: "auto", width: 1, height: 1, overflow: "hidden" }}>
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>
      </div>
      {error ? <div className="r-error" role="alert">{error}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="r-btn" style={{ padding: "11px 22px" }} disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </div>
    </form>
  );
}
