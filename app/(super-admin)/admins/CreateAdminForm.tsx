"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CreateAdminForm({ brokers }: { brokers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [brokerId, setBrokerId] = useState(brokers[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"BROKER_ADMIN" | "MANAGER" | "SUPPORT">("BROKER_ADMIN");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/admin/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brokerId, email, password, role }),
    });

    setSubmitting(false);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "failed to create admin");
      return;
    }

    setEmail("");
    setPassword("");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
      <h2>Create admin</h2>
      <select value={brokerId} onChange={(e) => setBrokerId(e.target.value)} required>
        {brokers.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="Initial password (min 8 chars)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <select value={role} onChange={(e) => setRole(e.target.value as "BROKER_ADMIN" | "MANAGER" | "SUPPORT")}>
        <option value="BROKER_ADMIN">Broker Admin</option>
        <option value="MANAGER">Manager</option>
        <option value="SUPPORT">Support</option>
      </select>
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
      <button type="submit" disabled={submitting || !brokerId}>
        {submitting ? "Creating..." : "Create admin"}
      </button>
    </form>
  );
}
