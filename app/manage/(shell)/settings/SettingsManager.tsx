"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";

type BrokerInfo = { name: string; subdomain: string; customDomain: string | null; tier: string; status: string };

// Same mapping as app/(super-admin)/(shell)/brokers/BrokersManager.tsx's
// own statusTone -- same BrokerStatus enum, same badge language.
const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;
type Defaults = { defaultAccountCurrency: string; defaultAccountLeverage: number };

export default function SettingsManager({ broker, initial }: { broker: BrokerInfo; initial: Defaults }) {
  const router = useRouter();
  const [currency, setCurrency] = useState(initial.defaultAccountCurrency);
  const [leverage, setLeverage] = useState(String(initial.defaultAccountLeverage));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Broker info" description="Read-only — edited in the Super Admin console.">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-[var(--text-3)]">Name</dt>
          <dd className="text-[var(--text-1)]">{broker.name}</dd>
          <dt className="text-[var(--text-3)]">Subdomain</dt>
          <dd className="font-mono text-[var(--text-1)]">{broker.subdomain}</dd>
          <dt className="text-[var(--text-3)]">Custom domain</dt>
          <dd className="font-mono text-[var(--text-1)]">{broker.customDomain ?? "—"}</dd>
          <dt className="text-[var(--text-3)]">Tier</dt>
          <dd className="text-[var(--text-1)]">{broker.tier}</dd>
          <dt className="text-[var(--text-3)]">Status</dt>
          <dd>
            <Badge tone={statusTone[broker.status as keyof typeof statusTone] ?? "neutral"}>{broker.status}</Badge>
          </dd>
        </dl>
      </Card>

      <Card title="Default account settings" description="Applied when Add Account doesn't specify currency/leverage.">
        <form onSubmit={save} className="flex flex-col gap-4">
          <FormField label="Default currency">
            <Input type="text" mono value={currency} onChange={(e) => { setCurrency(e.target.value); setSaved(false); }} className="max-w-xs" />
          </FormField>
          <FormField label="Default leverage">
            <Input type="text" inputMode="numeric" mono value={leverage} onChange={(e) => { setLeverage(e.target.value); setSaved(false); }} className="max-w-xs" />
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
