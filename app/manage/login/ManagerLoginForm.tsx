"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Checkbox } from "@/components/ui/Checkbox";
import styles from "./ManagerLoginForm.module.css";

export default function ManagerLoginForm({
  brokerName,
  logoUrl,
  supportEmail,
}: {
  brokerName: string;
  logoUrl: string | null;
  supportEmail: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter both your email and password.");
      return;
    }
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }

    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/manage/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password, remember }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "login failed");
      return;
    }

    // Brief real confirmation before the redirect, not a fake delay --
    // matches how the credential check itself already took a moment.
    setSignedIn(true);
    setTimeout(() => router.push("/manage/dashboard"), 500);
  }

  return (
    <div className={styles.shell}>
      <div className={styles.brandPanel}>
        <div className={styles.brandMesh} />
        <div className={styles.brandGrid} />

        <div className={styles.brokerId}>
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-[38px] w-[38px] shrink-0 rounded-[10px] object-cover" />
          ) : (
            <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent)] text-[15px] font-bold text-white">
              {brokerName.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <div className="text-[16px] font-bold text-[var(--text-1)]">{brokerName} Backoffice</div>
            <div className="mt-px text-[11.5px] text-[var(--text-3)]">Broker management console</div>
          </div>
        </div>

        <div className={styles.brandQuote}>
          <div className={styles.brandQuoteMark}>&ldquo;</div>
          <div className="text-[19px] font-medium leading-[1.5] text-[var(--text-1)]">
            Every deposit, withdrawal and dealing decision — logged, auditable, and never one click away from a mistake.
          </div>
          <div className="mt-4 text-xs text-[var(--text-3)]">Built for teams who manage real client money.</div>
        </div>

        <div className={styles.brandFooter}>
          <div className={styles.vyxMark} />
          Powered by vyXTrader
        </div>
      </div>

      <div className={styles.formPanel}>
        <div className={styles.formBox}>
          {signedIn ? (
            <div className={styles.step}>
              <div className={styles.successIcon}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">You&apos;re in</h1>
              <p className="mt-1.5 text-[12.5px] text-[var(--text-3)]">Redirecting you to the dashboard…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className={styles.step}>
              <h1 className="text-[20px] font-bold tracking-tight text-[var(--text-1)]">Sign in</h1>
              <p className="mb-7 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--text-3)]">Access your broker&apos;s management console.</p>

              {error ? (
                <div className="mb-4">
                  <Alert tone="danger">{error}</Alert>
                </div>
              ) : null}

              <div className="mb-4">
                <FormField label="Email address" htmlFor="email">
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@broker.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </FormField>
              </div>

              <div className="mb-4">
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="password" className="text-[11px] text-[var(--text-3)]">
                    Password
                  </label>
                  {supportEmail ? (
                    <a
                      href={`mailto:${supportEmail}?subject=${encodeURIComponent("Backoffice password reset")}`}
                      className="text-[11.5px] font-medium text-[var(--accent)] hover:underline"
                    >
                      Forgot password?
                    </a>
                  ) : null}
                </div>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className="mb-6">
                <Checkbox
                  id="remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  label="Keep me signed in for 30 days"
                />
              </div>

              <Button type="submit" variant="primary" loading={submitting} className="w-full">
                {submitting ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
