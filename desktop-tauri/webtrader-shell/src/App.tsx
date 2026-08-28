import { useState, type FormEvent } from "react";
import WebTrader from "@/components/webtrader/WebTrader";
import { tradeApi } from "@/lib/trade-api";
import "@/app/(broker)/trade/webtrader.css";

// Phase 2 spike: proves components/webtrader/WebTrader.tsx renders and
// trades unmodified outside of Next.js. Branding is hardcoded to the
// seeded AcmeFX broker here -- real per-install branding (fetched via
// window.vyxDesktop at Rust startup) is Phase 5's job, not this one.
export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await tradeApi.login(accountNumber, password, "DEMO");
      setLoggedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  if (!loggedIn) {
    return (
      <form
        onSubmit={handleLogin}
        style={{
          maxWidth: 320,
          margin: "80px auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h2>vyXTrader Shell (dev spike)</h2>
        <input
          placeholder="Account number"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div style={{ color: "red" }}>{error}</div>}
        <button type="submit">Log in</button>
      </form>
    );
  }

  return (
    <WebTrader
      brokerName="AcmeFX"
      brokerLogoUrl="https://placehold.co/160x40?text=AcmeFX"
      supportEmail={null}
      onSessionExpired={() => setLoggedIn(false)}
    />
  );
}
