"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

// useSearchParams() (below, for the ?reason=expired notice) opts this
// page out of static prerendering unless wrapped in Suspense -- the
// build fails without this ("useSearchParams() should be wrapped in a
// suspense boundary"). The fallback is effectively invisible in
// practice (this page has no server data to wait on, so the real
// component resolves on the same tick).
export default function SuperAdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <SuperAdminLoginForm />
    </Suspense>
  );
}

function SuperAdminLoginForm() {
  const router = useRouter();
  // VYX-BASICS-AUDIT.md category 4 "session-expiry -> clean redirect
  // with a message" -- app/(super-admin)/(shell)/layout.tsx appends
  // ?reason=expired when it redirects here over a missing/invalid
  // session; cleared the moment the admin starts typing, same reasoning
  // as ManagerLoginForm.tsx's own showExpiredNotice.
  const searchParams = useSearchParams();
  const [showExpiredNotice, setShowExpiredNotice] = useState(searchParams.get("reason") === "expired");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "login failed");
      return;
    }

    const body = await response.json();
    // Password alone isn't enough once 2FA is turned on (see
    // app/(super-admin)/(shell)/security) -- swap to the code-entry step
    // instead of navigating away.
    if (body.requiresTwoFactor) {
      setPendingToken(body.pendingToken);
      return;
    }

    router.push("/brokers");
  }

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/admin/login/verify-2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingToken, code }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "verification failed");
      return;
    }

    router.push("/brokers");
  }

  if (pendingToken) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <Card className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[var(--accent)] text-sm font-bold text-[#0a0714]">
              X
            </div>
            <h1 className="text-lg font-semibold text-[var(--text-1)]">Two-factor verification</h1>
          </div>
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <p className="text-sm text-[var(--text-3)]">Enter the 6-digit code from your authenticator app.</p>
            <FormField label="Code" htmlFor="code">
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
                maxLength={6}
                mono
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                className="text-center tracking-[4px] text-lg"
              />
            </FormField>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <Button type="submit" variant="primary" loading={submitting} disabled={code.length !== 6} className="w-full">
              {submitting ? "Verifying..." : "Verify"}
            </Button>
            <button
              type="button"
              className="text-center text-xs text-[var(--text-3)] hover:text-[var(--text-1)]"
              onClick={() => {
                setPendingToken(null);
                setCode("");
                setError(null);
              }}
            >
              Back to sign in
            </button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[var(--accent)] text-sm font-bold text-[#0a0714]">
            X
          </div>
          <h1 className="text-lg font-semibold text-[var(--text-1)]">vyX Super Admin</h1>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="Email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@vyxtrader.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setShowExpiredNotice(false);
              }}
              required
            />
          </FormField>
          <FormField label="Password" htmlFor="password">
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </FormField>
          {error ? <Alert tone="danger">{error}</Alert> : showExpiredNotice ? <Alert tone="warning">Your session expired. Sign in again to continue.</Alert> : null}
          <Button type="submit" variant="primary" loading={submitting} className="w-full">
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
