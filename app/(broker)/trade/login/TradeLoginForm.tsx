"use client";

import { useEffect, useRef, useState } from "react";
import { tradeApi } from "@/lib/trade-api";
import DesktopTitleBar from "@/components/webtrader/DesktopTitleBar";
import "../webtrader.css";
import styles from "./TradeLoginForm.module.css";

type ServerOption = { name: string; type: "LIVE" | "DEMO" };

const REMEMBERED_SERVER_KEY = "vyx-trade-server-type";

// Portable core -- no next/navigation dependency, so a bundled Vite shell
// (desktop-tauri/webtrader-shell) can render this exact login experience
// (Live/Demo server picker, 2FA, forgot-password, "save account and
// connect automatically") instead of duplicating a thinner one by hand,
// same "extract the router dependency out" pattern as AdminShell.tsx/
// NextAdminShell.tsx. The website keeps using NextTradeLoginForm.tsx
// (below-adjacent file), which supplies the searchParams-derived props
// and the router-based onAuthenticated default; a bundled shell instead
// passes its own onAuthenticated that flips local state and calls
// window.vyxDesktop.rememberSession()/forgetSession().
export default function TradeLoginForm({
  brokerName,
  brokerLogoUrl,
  supportEmail,
  initialAccountNumber = "",
  initialError = null,
  initialPendingToken = null,
  initialRemember = true,
  onAuthenticated,
}: {
  brokerName: string;
  brokerLogoUrl?: string | null;
  supportEmail: string | null;
  initialAccountNumber?: string;
  initialError?: string | null;
  initialPendingToken?: string | null;
  initialRemember?: boolean;
  // Called instead of navigating to /trade after a successful login or
  // 2FA verification -- `remember` mirrors the "save account and connect
  // automatically" checkbox so a caller can decide what that means in its
  // own context (the website encodes it in the /trade?remember=0 query
  // string; a bundled shell instead persists/clears the native session
  // file via window.vyxDesktop.rememberSession()/forgetSession()).
  onAuthenticated: (remember: boolean) => void;
}) {
  // Single-broker builds (the only mode any shipped desktop.config.json
  // uses today -- see desktop-tauri/src-tauri/src/main.rs) have exactly
  // one broker, so "server" here means this broker's Live vs. Demo
  // trading environment, not a choice between different brokers -- that
  // broker-picker already exists separately at app/launch/page.tsx.
  const servers: ServerOption[] = [
    { name: `${brokerName}-Live`, type: "LIVE" },
    { name: `${brokerName}-Demo`, type: "DEMO" },
  ];

  const [selectedServer, setSelectedServer] = useState<ServerOption>(servers[0]);
  const [serverOpen, setServerOpen] = useState(false);
  const [serverSearch, setServerSearch] = useState("");
  const serverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBERED_SERVER_KEY);
      const match = servers.find((s) => s.type === saved);
      if (match) setSelectedServer(match);
    } catch {
      // localStorage unavailable (private mode, etc.) -- default stands.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (serverRef.current && !serverRef.current.contains(event.target as Node)) {
        setServerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function pickServer(server: ServerOption) {
    setSelectedServer(server);
    setServerOpen(false);
    setServerSearch("");
    try {
      window.localStorage.setItem(REMEMBERED_SERVER_KEY, server.type);
    } catch {
      // Non-fatal -- just means the choice isn't remembered next visit.
    }
  }

  // Prefilled when arriving from the root-domain server picker (app/launch)
  // — that page only knows which server the trader picked, not their
  // password, so it hands off here for the actual credential entry.
  const [accountNumber, setAccountNumber] = useState(initialAccountNumber);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);
  const [connStatus, setConnStatus] = useState("Not connected");
  const [remember, setRemember] = useState(initialRemember);

  // Two-factor step -- either reached from this form's own submit (the
  // JSON login path), or arriving already here via the login-redirect
  // route's query string (the root-domain launcher's cross-site form-POST
  // path, which can't return JSON) -- both funnel into the same
  // POST /api/trade/login/verify-2fa call below.
  const [pendingToken, setPendingToken] = useState<string | null>(initialPendingToken);
  const [twoFactorCode, setTwoFactorCode] = useState("");

  // Forgot-password step -- an in-app request instead of a mailto: link
  // (which does nothing if the device has no email client configured,
  // and leaves no record the broker can act on). Shows up as a
  // Notification in the broker's Manager backoffice
  // (app/manage/(shell)/notifications) with a "Reset password" action.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotAccountNumber, setForgotAccountNumber] = useState("");
  const [forgotNote, setForgotNote] = useState("");
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleForgotPassword(event: React.FormEvent) {
    event.preventDefault();
    setForgotSubmitting(true);
    await fetch("/api/trade/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountNumber: forgotAccountNumber.trim(), note: forgotNote.trim() }),
    }).catch(() => {});
    setForgotSubmitting(false);
    setForgotSent(true);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!accountNumber.trim() || !password) {
      setError("Enter both your account number and password.");
      return;
    }
    if (!/^\d+$/.test(accountNumber.trim())) {
      setError("Account number should contain digits only.");
      return;
    }

    setSubmitting(true);
    setConnStatus(`Connecting to ${selectedServer.name}…`);
    try {
      const result = await tradeApi.login(accountNumber.trim(), password, selectedServer.type);
      if ("requiresTwoFactor" in result) {
        setPendingToken(result.pendingToken);
        setConnStatus("Not connected");
        return;
      }
      setConnStatus(`Connected · ${selectedServer.name}`);
      onAuthenticated(remember);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
      setConnStatus("Not connected");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyTwoFactor(event: React.FormEvent) {
    event.preventDefault();
    if (!pendingToken) return;
    setSubmitting(true);
    setError(null);
    try {
      await tradeApi.verifyTwoFactor(pendingToken, twoFactorCode);
      onAuthenticated(remember);
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  const filteredServers = servers.filter((s) => s.name.toLowerCase().includes(serverSearch.toLowerCase()));

  if (pendingToken) {
    return (
      <div className="wt-root" data-theme="default" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <DesktopTitleBar brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} server="" connected={false} />
        <div className={styles.loginArea}>
          <div className={styles.loginMesh} />
          <form onSubmit={handleVerifyTwoFactor} className={styles.loginCard}>
            <h1 className={styles.title}>Two-factor verification</h1>
            <p className={styles.subtitle}>Enter the 6-digit code from your authenticator app.</p>
            {error ? <div className={styles.formError}>{error}</div> : null}
            <div className={styles.field}>
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
                maxLength={6}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ""))}
                required
                className={`${styles.input} ${styles.inputMono}`}
                style={{ textAlign: "center", letterSpacing: 4, fontSize: 18 }}
              />
            </div>
            <button type="submit" disabled={submitting || twoFactorCode.length !== 6} className={styles.btnLogin}>
              {submitting ? "Verifying…" : "Verify"}
            </button>
            <div className={styles.loginFooter}>
              <a
                onClick={() => {
                  setPendingToken(null);
                  setTwoFactorCode("");
                  setError(null);
                }}
              >
                Back to sign in
              </a>
            </div>
          </form>
        </div>
        <div className={styles.statusbar}>
          <span>{connStatus}</span>
        </div>
      </div>
    );
  }

  if (forgotOpen) {
    return (
      <div className="wt-root" data-theme="default" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <DesktopTitleBar brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} server="" connected={false} />
        <div className={styles.loginArea}>
          <div className={styles.loginMesh} />
          {forgotSent ? (
            <div className={styles.loginCard}>
              <h1 className={styles.title}>Request sent</h1>
              <p className={styles.subtitle}>
                If that account number exists, {brokerName}&apos;s support team has been notified and will reset your
                password directly.
              </p>
              <button
                type="button"
                className={styles.btnLogin}
                onClick={() => {
                  setForgotOpen(false);
                  setForgotSent(false);
                  setForgotAccountNumber("");
                  setForgotNote("");
                }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className={styles.loginCard}>
              <h1 className={styles.title}>Forgot password</h1>
              <p className={styles.subtitle}>
                Enter your account number and {brokerName}&apos;s support team will reset your password for you.
              </p>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Account number</label>
                <input
                  inputMode="numeric"
                  placeholder="e.g. 50291843"
                  autoFocus
                  value={forgotAccountNumber}
                  onChange={(e) => setForgotAccountNumber(e.target.value.replace(/\D/g, ""))}
                  required
                  className={`${styles.input} ${styles.inputMono}`}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Note (optional)</label>
                <input
                  placeholder="Anything that helps support verify it's you"
                  value={forgotNote}
                  onChange={(e) => setForgotNote(e.target.value)}
                  className={styles.input}
                />
              </div>
              <button type="submit" disabled={forgotSubmitting || !forgotAccountNumber.trim()} className={styles.btnLogin}>
                {forgotSubmitting ? "Sending…" : "Send request"}
              </button>
              <div className={styles.loginFooter}>
                <a onClick={() => setForgotOpen(false)}>Back to sign in</a>
              </div>
            </form>
          )}
        </div>
        <div className={styles.statusbar}>
          <span>{connStatus}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="wt-root" data-theme="default" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <DesktopTitleBar brokerName={brokerName} brokerLogoUrl={brokerLogoUrl} server="" connected={false} />

      <div className={styles.loginArea}>
        <div className={styles.loginMesh} />

        <form onSubmit={handleSubmit} className={styles.loginCard}>
          <h1 className={styles.title}>Sign in to {brokerName}</h1>
          <p className={styles.subtitle}>Enter your trading account number and password.</p>

          {error ? <div className={styles.formError}>{error}</div> : null}

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Server</label>
            <div className={styles.serverSelect} ref={serverRef}>
              <div
                className={`${styles.serverTrigger} ${serverOpen ? styles.serverTriggerOpen : ""}`}
                onClick={() => setServerOpen((v) => !v)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setServerOpen((v) => !v);
                  }
                }}
              >
                <span className={styles.serverTriggerLeft}>
                  <span className={`${styles.serverDot} ${selectedServer.type === "LIVE" ? styles.serverDotLive : styles.serverDotDemo}`} />
                  <span className={styles.serverName}>{selectedServer.name}</span>
                </span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={styles.serverChevron}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
              {serverOpen ? (
                <div className={styles.serverDropdown}>
                  <input
                    className={styles.serverSearch}
                    placeholder="Search server…"
                    value={serverSearch}
                    onChange={(e) => setServerSearch(e.target.value)}
                    autoFocus
                  />
                  {filteredServers.length === 0 ? (
                    <div className={styles.serverEmpty}>No servers found</div>
                  ) : (
                    filteredServers.map((s) => (
                      <button type="button" key={s.type} className={styles.serverOption} onClick={() => pickServer(s)}>
                        <span className={`${styles.serverDot} ${s.type === "LIVE" ? styles.serverDotLive : styles.serverDotDemo}`} />
                        <span>{s.name}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Account number</label>
            <input
              name="account"
              autoComplete="username"
              placeholder="e.g. 50291843"
              inputMode="numeric"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
              className={`${styles.input} ${styles.inputMono}`}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Password</label>
            <div className={styles.passwordWrap}>
              <input
                name="password"
                type={passwordVisible ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={styles.input}
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setPasswordVisible((v) => !v)}
                title={passwordVisible ? "Hide password" : "Show password"}
                aria-label={passwordVisible ? "Hide password" : "Show password"}
              >
                {passwordVisible ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </div>

          <div className={styles.rememberRow}>
            <button
              type="button"
              className={`${styles.checkbox} ${remember ? styles.checkboxChecked : ""}`}
              onClick={() => setRemember((v) => !v)}
              aria-pressed={remember}
              aria-label="Save account and connect automatically"
            >
              {remember ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#04140C" strokeWidth="3.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </button>
            <button type="button" className={styles.rememberLabel} onClick={() => setRemember((v) => !v)}>
              Save account and connect automatically
            </button>
          </div>

          <button type="submit" disabled={submitting} className={styles.btnLogin}>
            {submitting ? "Connecting…" : "Login"}
          </button>

          <div className={styles.loginFooter}>
            {supportEmail ? (
              <a href={`mailto:${supportEmail}?subject=${encodeURIComponent("New to trading — open a demo account")}`}>
                New to trading? Open a demo account
              </a>
            ) : null}
            <a
              onClick={() => {
                setForgotAccountNumber(accountNumber);
                setForgotOpen(true);
              }}
            >
              Forgot password?
            </a>
          </div>
        </form>
      </div>

      <div className={styles.statusbar}>
        <span>{connStatus}</span>
      </div>
    </div>
  );
}
