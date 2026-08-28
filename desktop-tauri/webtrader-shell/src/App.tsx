import { useEffect, useState, type FormEvent } from "react";
import WebTrader from "@/components/webtrader/WebTrader";
import DesktopTitleBar from "@/components/webtrader/DesktopTitleBar";
import { tradeApi, type ApiBrokerBranding } from "@/lib/trade-api";
import "@/app/(broker)/trade/webtrader.css";

// The bundled Client Trading Terminal's real entry point (desktop-tauri's
// tauri.conf.json build.frontendDist points here) -- not a dev spike.
// Branding is fetched once on mount via tradeApi.brokerBranding() (no
// session needed, see its own route) since this shell has no Server
// Component of its own to inject it server-side the way the website does.
export default function App() {
  const [branding, setBranding] = useState<ApiBrokerBranding | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  // Only desktop-tauri has a persisted session file to check (see
  // remember_session/forget_session in main.rs) -- a plain browser tab has
  // no such thing, so there's nothing to wait on there and the login form
  // should render immediately, same as before this feature existed.
  const [checkingSession, setCheckingSession] = useState(() => !!window.vyxDesktop?.rememberSession);

  useEffect(() => {
    tradeApi
      .brokerBranding()
      .then(setBranding)
      .catch(() => setBranding({ brokerName: "VyXTrader", brokerLogoUrl: "", supportEmail: null }));
  }, []);

  // If main.rs found a saved session file, it pre-seeds the reqwest cookie
  // jar with it before this ever runs -- a plain apiCall("/api/trade/me")
  // either succeeds (cookie still valid server-side) or fails (expired/
  // revoked), in which case the login form shows as normal.
  useEffect(() => {
    if (!window.vyxDesktop?.rememberSession) return;
    tradeApi
      .me()
      .then(() => setLoggedIn(true))
      .catch(() => {})
      .finally(() => setCheckingSession(false));
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoggingIn(true);
    try {
      await tradeApi.login(accountNumber, password, "DEMO");
      if (rememberMe) {
        window.vyxDesktop?.rememberSession?.();
      } else {
        window.vyxDesktop?.forgetSession?.();
      }
      setLoggedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  if (checkingSession) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#07090C" }}>
        <DesktopTitleBar brokerName={branding?.brokerName ?? ""} server="" connected={true} />
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#07090C" }}>
        {/* Login screen renders before window.vyxDesktop.onMaximizedChange has
            anything meaningful to report and before any live feed exists --
            DesktopTitleBar already no-ops outside a desktop shell, and
            connected=true here just avoids a misleading "disconnected" signal
            for a concept (the live price feed) that doesn't apply yet. */}
        <DesktopTitleBar brokerName={branding?.brokerName ?? ""} server="" connected={true} />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "#e8ecf4",
            fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          }}
        >
          {branding?.brokerLogoUrl ? (
            <img src={branding.brokerLogoUrl} alt={branding.brokerName} style={{ maxHeight: 40, marginBottom: 24 }} />
          ) : (
            <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 24 }}>{branding?.brokerName ?? ""}</div>
          )}
          <form
            onSubmit={handleLogin}
            style={{ width: 280, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <input
              placeholder="Account number"
              inputMode="numeric"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))}
              style={{ padding: 10, borderRadius: 6, border: "1px solid #1A222C", background: "#0E1319", color: "#e8ecf4" }}
            />
            <input
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ padding: 10, borderRadius: 6, border: "1px solid #1A222C", background: "#0E1319", color: "#e8ecf4" }}
            />
            {window.vyxDesktop?.rememberSession && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#8B93A1", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Remember me
              </label>
            )}
            {error && <div style={{ color: "#EA3943", fontSize: 13 }}>{error}</div>}
            <button
              type="submit"
              disabled={loggingIn}
              style={{ padding: 10, borderRadius: 6, border: "none", background: "#16C784", color: "#07090C", fontWeight: 600, cursor: "pointer" }}
            >
              {loggingIn ? "Logging in..." : "Log in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <WebTrader
      brokerName={branding?.brokerName ?? "VyXTrader"}
      brokerLogoUrl={branding?.brokerLogoUrl ?? ""}
      supportEmail={branding?.supportEmail ?? null}
      onSessionExpired={() => setLoggedIn(false)}
    />
  );
}
