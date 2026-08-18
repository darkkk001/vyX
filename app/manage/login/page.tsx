"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export default function ManagerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/manage/login", {
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

    router.push("/manage/symbols");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <h1 className="mb-6 text-lg font-semibold text-slate-900">VyXTrader Manager</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              placeholder="you@broker.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </FormField>
          <FormField label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </FormField>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" variant="primary" loading={submitting} className="w-full">
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
