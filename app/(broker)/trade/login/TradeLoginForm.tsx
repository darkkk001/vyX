"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { tradeApi } from "@/lib/trade-api";
import DesktopTitleBar from "@/components/webtrader/DesktopTitleBar";
import "../webtrader.css";
import styles from "./TradeLoginForm.module.css";

type ServerOption = { name: string; type: "LIVE" | "DEMO" };

const REMEMBERED_SERVER_KEY = "vyx-trade-server-type";

export default function TradeLoginForm({
  brokerName,
  supportEmail,
}: {
  brokerName: string;
  supportEmail: string | null;
}) {
  return (
    <Suspense fallback={null}>
      <TradeLoginFormInner brokerName={brokerName} supportEmail={supportEmail} />
    </Suspense>
  );
}

function TradeLoginFormInner({ brokerName, supportEmail }: { brokerName: string; supportEmail: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();

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
  const [accountNumber, setAccountNumber] = useState(searchParams.get("account") ?? "");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  // Set when bounced back here by /api/trade/login-redirect (the
  // root-domain launcher's single-screen login failing invalid credentials).
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "Invalid account number or password" : null
  );
  const [submitting, setSubmitting] = useState(false);
  const [connStatus, setConnStatus] = useState("Not connected");
  const [remember, setRemember] = useState(searchParams.get("remember") !== "0");

  // Two-factor step -- either reached from this form's own submit (the
  // JSON login path), or arriving already here via the login-redirect
  // route's query string (the root-domain launcher's cross-site form-POST
  // path, which can't return JSON) -- both funnel into the same
  // POST /api/trade/login/verify-2fa call below.
  const [pendingToken, setPendingToken] = useState<string | null>(searchParams.get("pendingToken"));
  const [twoFactorCode, setTwoFactorCode] = useState("");

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
      router.push(remember ? "/trade" : "/trade?remember=0");
      router.refresh();
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
      router.push(remember ? "/trade" : "/trade?remember=0");
      router.refresh();
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
        <DesktopTitleBar brokerName={brokerName} server="" connected={false} />
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

  return (
    <div className="wt-root" data-theme="default" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <DesktopTitleBar brokerName={brokerName} server="" connected={false} />

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
              <>
                <a href={`mailto:${supportEmail}?subject=${encodeURIComponent("New to trading — open a demo account")}`}>
                  New to trading? Open a demo account
                </a>
                <a href={`mailto:${supportEmail}?subject=${encodeURIComponent("Forgot password")}`}>Forgot password?</a>
              </>
            ) : null}
          </div>
        </form>
      </div>

      <div className={styles.statusbar}>
        <span>{connStatus}</span>
      </div>
    </div>
  );
}
