"use client";

import { useEffect, useState } from "react";

type PublicBroker = { name: string; subdomain: string; logoUrl: string | null };

// Root-domain "pick your server" screen — the generic desktop app build (no
// broker baked in) and anyone landing on the bare domain start here, same
// role as MT5's server dropdown. Password isn't collected here: this page
// only decides which broker subdomain to send the trader to, then their
// actual login happens on that broker's own /trade/login (same origin as
// the session cookie it sets) — carrying a password across domains via a
// redirect would mean putting it in a URL, which we don't do.
export default function LaunchPage() {
  const [brokers, setBrokers] = useState<PublicBroker[] | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/public/brokers")
      .then((r) => r.json())
      .then((list: PublicBroker[]) => {
        setBrokers(list);
        if (list.length > 0) setSubdomain(list[0].subdomain);
      })
      .catch(() => setError("Could not load broker list"));
  }, []);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!subdomain) {
      setError("Select a server");
      return;
    }
    const qs = accountNumber ? `?account=${encodeURIComponent(accountNumber)}` : "";
    window.location.href = `https://${subdomain}/trade/login${qs}`;
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
        <p style={{ fontSize: 12, color: "#8891a6", margin: "0 0 8px" }}>
          Select your broker's server to continue.
        </p>

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

        <label style={{ fontSize: 12, color: "#8891a6" }}>Account number (optional)</label>
        <input
          placeholder="Account number"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
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
          Continue
        </button>
      </form>
    </main>
  );
}
