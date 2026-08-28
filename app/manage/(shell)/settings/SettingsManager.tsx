"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { LeverageInput } from "@/components/ui/LeverageInput";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";

type SettingsData = {
  name: string;
  subdomain: string;
  customDomain: string | null;
  tier: string;
  status: string;
  defaultAccountCurrency: string;
  defaultAccountLeverage: number;
};

// Same mapping as app/(super-admin)/(shell)/brokers/BrokersManager.tsx's
// own statusTone -- same BrokerStatus enum, same badge language.
const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;

// Self-fetches from /api/manage/settings (a route that already returned
// exactly this combined broker+defaults shape, unmodified) instead of
// receiving broker/initial as server-rendered props -- both the website
// and a bundled manager-shell desktop app (no Server Component of its
// own) share this one path now.
export default function SettingsManager() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [currency, setCurrency] = useState("");
  const [leverage, setLeverage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manage/settings")
      .then((r) => r.json())
      .then((d: SettingsData) => {
        setData(d);
        setCurrency(d.defaultAccountCurrency);
        setLeverage(String(d.defaultAccountLeverage));
      })
      .catch(() => setError("failed to load"));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    const response = await fetch("/api/manage/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAccountCurrency: currency, defaultAccountLeverage: leverage }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    const updated = await response.json();
    setData((prev) => (prev ? { ...prev, ...updated } : prev));
    setSaved(true);
  }

  if (!data) {
    return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Broker info" description="Read-only — edited in the Super Admin console.">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-[var(--text-3)]">Name</dt>
          <dd className="text-[var(--text-1)]">{data.name}</dd>
          <dt className="text-[var(--text-3)]">Subdomain</dt>
          <dd className="font-mono text-[var(--text-1)]">{data.subdomain}</dd>
          <dt className="text-[var(--text-3)]">Custom domain</dt>
          <dd className="font-mono text-[var(--text-1)]">{data.customDomain ?? "—"}</dd>
          <dt className="text-[var(--text-3)]">Tier</dt>
          <dd className="text-[var(--text-1)]">{data.tier}</dd>
          <dt className="text-[var(--text-3)]">Status</dt>
          <dd>
            <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? "neutral"}>{data.status}</Badge>
          </dd>
        </dl>
      </Card>

      <Card title="Default account settings" description="Applied when Add Account doesn't specify currency/leverage.">
        <form onSubmit={save} className="flex flex-col gap-4">
          <FormField label="Default currency">
            <Input type="text" mono value={currency} onChange={(e) => { setCurrency(e.target.value); setSaved(false); }} className="max-w-xs" />
          </FormField>
          <FormField label="Default leverage">
            <LeverageInput value={leverage} onChange={(e) => { setLeverage(e.target.value); setSaved(false); }} className="max-w-xs" />
          </FormField>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            {saved ? <span className="text-sm text-[var(--buy)]">Saved</span> : null}
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      </Card>
    </div>
  );
}
