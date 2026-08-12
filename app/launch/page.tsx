"use client";

import { useEffect, useState } from "react";

type PublicBroker = { name: string; subdomain: string; logoUrl: string | null };

// Root-domain "pick your server" screen — the generic desktop app build (no
// broker baked in) and anyone landing on the bare domain start here, same
// role as MT5's single login+password+server screen. Submitting does a real
// cross-site <form method="POST"> to the picked broker's own subdomain
// (app/api/trade/login-redirect) — a top-level navigation, which browsers
// allow across origins unlike fetch/XHR — so the password never has to
// travel through a URL, and the session cookie that route sets ends up
// correctly scoped to that broker's subdomain, not this launcher's root
// domain.
export default function LaunchPage() {
  const [brokers, setBrokers] = useState<PublicBroker[] | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rootHost, setRootHost] = useState("");

  useEffect(() => {
    setRootHost(window.location.hostname.replace(/^www\./, ""));
    fetch("/api/public/brokers")
      .then((r) => r.json())
      .then((list: PublicBroker[]) => {
        setBrokers(list);
        if (list.length > 0) setSubdomain(list[0].subdomain);
      })
      .catch(() => setError("Could not load broker list"));
  }, []);

  // Broker.subdomain (from the API) is just the label ("acmefx"), not a
  // full host — build the real one off whatever root domain this page
  // itself is being served from, so this keeps working the same in prod,
  // preview, or local dev without hardcoding vyxtrader.com here.
  const actionUrl = subdomain && rootHost ? `https://${subdomain}.${rootHost}/api/trade/login-redirect` : undefined;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!actionUrl) {
      event.preventDefault();
      setError("Select a server");
      return;
    }
    setError(null);
    // No preventDefault from here — this is a real form submission that
    // navigates the browser to another origin.
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0e14",
        color: "#e8ecf4",
        fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <form
        method="POST"
        action={actionUrl}
        onSubmit={handleSubmit}
        style={{
          width: 340,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "#111621",
          border: "1px solid #262e42",
          borderRadius: 10,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>VyXTrader</h1>
        <p style={{ fontSize: 12, color: "#8891a6", margin: "0 0 8px" }}>Sign in to your account.</p>

        <label style={{ fontSize: 12, color: "#8891a6" }}>Server</label>
        <select
          value={subdomain}
          onChange={(e) => setSubdomain(e.target.value)}
          required
          style={{
            background: "#161c2b",
            border: "1px solid #262e42",
            borderRadius: 6,
            padding: "8px 10px",
            color: "#e8ecf4",
          }}
        >
          {brokers === null ? (
            <option value="">Loading…</option>
          ) : brokers.length === 0 ? (
            <option value="">No brokers available</option>
          ) : (
            brokers.map((b) => (
              <option key={b.subdomain} value={b.subdomain}>
                {b.name}
              </option>
            ))
          )}
        </select>

        <label style={{ fontSize: 12, color: "#8891a6" }}>Account number</label>
        <input
          name="accountNumber"
          placeholder="Account number"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          required
          style={{
            background: "#161c2b",
            border: "1px solid #262e42",
            borderRadius: 6,
            padding: "8px 10px",
            color: "#e8ecf4",
          }}
        />

        <label style={{ fontSize: 12, color: "#8891a6" }}>Password</label>
        <input
          name="password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{
            background: "#161c2b",
            border: "1px solid #262e42",
            borderRadius: 6,
            padding: "8px 10px",
            color: "#e8ecf4",
          }}
        />

        {error ? <p style={{ color: "#f0526a", margin: 0, fontSize: 13 }}>{error}</p> : null}

        <button
          type="submit"
          disabled={!brokers || brokers.length === 0}
          style={{
            background: "#2f7dfb",
            border: "none",
            borderRadius: 6,
            padding: "10px",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
