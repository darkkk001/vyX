"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { tradeApi } from "@/lib/trade-api";

export default function TradeLoginForm({
  brokerName,
}: {
  brokerName: string;
}) {
  return (
    <Suspense fallback={null}>
      <TradeLoginFormInner brokerName={brokerName} />
    </Suspense>
  );
}

function TradeLoginFormInner({ brokerName }: { brokerName: string }) {
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

  // Two-factor step -- either reached from this form's own submit (the
  // JSON login path), or arriving already here via the login-redirect
  // route's query string (the root-domain launcher's cross-site form-POST
  // path, which can't return JSON) -- both funnel into the same
  // POST /api/trade/login/verify-2fa call below.
  const [pendingToken, setPendingToken] = useState<string | null>(searchParams.get("pendingToken"));
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const remember = searchParams.get("remember");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await tradeApi.login(accountNumber, password);
      if ("requiresTwoFactor" in result) {
        setPendingToken(result.pendingToken);
        return;
      }
      router.push("/trade");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
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
      // Preserves the desktop app's "remember this broker" choice when
      // this step was reached via /api/trade/login-redirect's own 2FA
      // branch (see that route) -- absent when reached from this page's
      // own credentials form, which has never set it either.
      router.push(remember !== null ? `/trade?remember=${remember}` : "/trade");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingToken) {
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
          onSubmit={handleVerifyTwoFactor}
          style={{ width: 320, display: "flex", flexDirection: "column", gap: 12, background: "#111621", border: "1px solid #262e42", borderRadius: 10, padding: 24 }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Two-factor verification</h1>
          <p style={{ fontSize: 13, color: "#8a93a6", margin: "0 0 4px" }}>Enter the 6-digit code from your authenticator app.</p>
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
            style={{ background: "#161c2b", border: "1px solid #262e42", borderRadius: 6, padding: "8px 10px", color: "#e8ecf4", letterSpacing: 4, fontSize: 18, textAlign: "center" }}
          />
          {error ? <p style={{ color: "#f0526a", margin: 0, fontSize: 13 }}>{error}</p> : null}
          <button
            type="submit"
            disabled={submitting || twoFactorCode.length !== 6}
            style={{ background: "#2f7dfb", border: "none", borderRadius: 6, padding: "10px", color: "white", fontWeight: 600, cursor: "pointer" }}
          >
            {submitting ? "Verifying..." : "Verify"}
          </button>
          <button
            type="button"
            onClick={() => { setPendingToken(null); setTwoFactorCode(""); setError(null); }}
            style={{ background: "transparent", border: "none", color: "#8a93a6", fontSize: 12, cursor: "pointer" }}
          >
            Back to sign in
          </button>
        </form>
      </main>
    );
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
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>{brokerName} Login</h1>
        <input
          name="account"
          autoComplete="username"
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
          name="password"
          type="password"
          autoComplete="current-password"
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
