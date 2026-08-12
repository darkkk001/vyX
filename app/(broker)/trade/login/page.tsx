"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { tradeApi } from "@/lib/trade-api";

export default function TradeLoginPage() {
  return (
    <Suspense fallback={null}>
      <TradeLoginForm />
    </Suspense>
  );
}

function TradeLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Prefilled when arriving from the root-domain server picker (app/launch)
  // — that page only knows which server the trader picked, not their
  // password, so it hands off here for the actual credential entry.
  const [accountNumber, setAccountNumber] = useState(searchParams.get("account") ?? "");
  const [password, setPassword] = useState("");
  // Set when bounced back here by /api/trade/login-redirect (the
  // root-domain launcher's single-screen login failing invalid credentials).
  const [error, setError] = useState<string | null>(
    searchParams.get("error") ? "Invalid account number or password" : null
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await tradeApi.login(accountNumber, password);
      router.push("/trade");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setSubmitting(false);
    }
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
          width: 320,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "#111621",
          border: "1px solid #262e42",
          borderRadius: 10,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>VyXTrader Login</h1>
        <input
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
        <input
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
          disabled={submitting}
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
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
