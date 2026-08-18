"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export default function CreateBrokerForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [tier, setTier] = useState<"STANDARD" | "WHITE_LABEL">("STANDARD");
  const [primaryColor, setPrimaryColor] = useState("#1e8a5f");
  const [logoUrl, setLogoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/admin/brokers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, subdomain, tier, primaryColor, logoUrl: logoUrl || null }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "failed to create broker");
      return;
    }

    setName("");
    setSubdomain("");
    setLogoUrl("");
    router.refresh();
  }

  return (
    <Card title="Create broker" className="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="Broker name">
          <Input placeholder="AcmeFX" value={name} onChange={(e) => setName(e.target.value)} required />
        </FormField>
        <FormField label="Subdomain">
          <Input placeholder="acmefx" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} required />
        </FormField>
        <FormField label="Tier">
          <Select value={tier} onChange={(e) => setTier(e.target.value as "STANDARD" | "WHITE_LABEL")}>
            <option value="STANDARD">Standard ($500/mo)</option>
            <option value="WHITE_LABEL">White-Label ($800/mo)</option>
          </Select>
        </FormField>
        <FormField label="Primary brand color">
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            title="Primary brand color"
            className="h-9 w-16 rounded border border-slate-300"
          />
        </FormField>
        <FormField label="Logo URL (optional)">
          <Input placeholder="https://..." value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
        </FormField>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create broker"}
        </Button>
      </form>
    </Card>
  );
}
