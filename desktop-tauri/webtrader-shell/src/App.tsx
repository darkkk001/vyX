import { useEffect, useState } from "react";
import WebTrader from "@/components/webtrader/WebTrader";
import DesktopTitleBar from "@/components/webtrader/DesktopTitleBar";
import TradeLoginForm from "@/app/(broker)/trade/login/TradeLoginForm";
import { tradeApi, type ApiBrokerBranding } from "@/lib/trade-api";
import "@/app/(broker)/trade/webtrader.css";

// The bundled Client Trading Terminal's real entry point (desktop-tauri's
// tauri.conf.json build.frontendDist points here) -- not a dev spike.
// Branding is fetched once on mount via tradeApi.brokerBranding() (no
// session needed, see its own route) since this shell has no Server
// Component of its own to inject it server-side the way the website does.
//
// The login screen itself is the real TradeLoginForm (Live/Demo server
// picker, 2FA, forgot-password) -- this used to be a thin hand-rolled
// duplicate that hardcoded the account mode to "DEMO", meaning no LIVE account
// could ever log into the bundled app at all. TradeLoginForm.tsx was made
// portable (no next/navigation dependency) specifically so this shell
// could render the exact same login experience as the website instead.
export default function App() {
  const [branding, setBranding] = useState<ApiBrokerBranding | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  // Only desktop-tauri has a persisted session file to check (see
  // remember_session/forget_session in main.rs) -- a plain browser tab has
  // no such thing, so there's nothing to wait on there and the login form
  // should render immediately, same as before this feature existed.
  const [checkingSession, setCheckingSession] = useState(() => !!window.vyxDesktop?.rememberSession);

  useEffect(() => {
    tradeApi
      .brokerBranding()
      .then(setBranding)
      .catch(() => setBranding({ brokerName: "VyXTrader", brokerLogoUrl: "", supportEmail: null, primaryColor: null }));
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

  // Mirrors app/(broker)/layout.tsx's own inline --brand-primary style,
  // which every website (broker) page gets for free via that Server
  // Component layout -- webtrader.css's --accent/--brand both fall back
  // to var(--brand-primary, #16C784) already, they just never had a real
  // value to read here since this shell has no equivalent layout wrapper.
  // Without this, every broker's bundled Trader terminal showed the
  // same generic green accent regardless of their actual brand color.
  const brandStyle = { ["--brand-primary" as string]: branding?.primaryColor || "#1e8a5f" };

  if (checkingSession) {
    return (
      <div style={{ ...brandStyle, display: "flex", flexDirection: "column", height: "100vh", background: "#07090C" }}>
        <DesktopTitleBar brokerName={branding?.brokerName ?? ""} brokerLogoUrl={branding?.brokerLogoUrl} server="" connected={true} />
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={brandStyle}>
        <TradeLoginForm
          brokerName={branding?.brokerName ?? "VyXTrader"}
          brokerLogoUrl={branding?.brokerLogoUrl}
          supportEmail={branding?.supportEmail ?? null}
          onAuthenticated={(remember) => {
            if (remember) {
              window.vyxDesktop?.rememberSession?.();
            } else {
              window.vyxDesktop?.forgetSession?.();
            }
            setLoggedIn(true);
          }}
        />
      </div>
    );
  }

  return (
    <div style={brandStyle}>
      <WebTrader
        brokerName={branding?.brokerName ?? "VyXTrader"}
        brokerLogoUrl={branding?.brokerLogoUrl ?? ""}
        supportEmail={branding?.supportEmail ?? null}
        onSessionExpired={() => setLoggedIn(false)}
      />
    </div>
  );
}
