"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
      <h2>Create broker</h2>
      <input placeholder="Broker name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input
        placeholder="Subdomain (e.g. acmefx)"
        value={subdomain}
        onChange={(e) => setSubdomain(e.target.value)}
        required
      />
      <select value={tier} onChange={(e) => setTier(e.target.value as "STANDARD" | "WHITE_LABEL")}>
        <option value="STANDARD">Standard ($500/mo)</option>
        <option value="WHITE_LABEL">White-Label ($800/mo)</option>
      </select>
      <input
        type="color"
        value={primaryColor}
        onChange={(e) => setPrimaryColor(e.target.value)}
        title="Primary brand color"
      />
      <input
        placeholder="Logo URL (optional)"
        value={logoUrl}
        onChange={(e) => setLogoUrl(e.target.value)}
      />
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating..." : "Create broker"}
      </button>
    </form>
  );
}
