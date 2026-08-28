"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export default function CreateAdminForm({ brokers, onCreated }: { brokers: { id: string; name: string }[]; onCreated?: () => void }) {
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
    onCreated?.();
  }

  return (
    <Card title="Create admin" className="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="Broker">
          <Select value={brokerId} onChange={(e) => setBrokerId(e.target.value)} required>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Email">
          <Input type="email" placeholder="admin@broker.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </FormField>
        <FormField label="Initial password">
          <Input
            type="password"
            placeholder="min 8 chars"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </FormField>
        <FormField label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as "BROKER_ADMIN" | "MANAGER" | "SUPPORT")}>
            <option value="BROKER_ADMIN">Broker Admin</option>
            <option value="MANAGER">Manager</option>
            <option value="SUPPORT">Support</option>
          </Select>
        </FormField>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" variant="primary" disabled={submitting || !brokerId}>
          {submitting ? "Creating..." : "Create admin"}
        </Button>
      </form>
    </Card>
  );
}
