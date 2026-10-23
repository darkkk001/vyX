"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";

// QoreBridge licenses for one broker (owner 2026-10-23, lib/bridge-licenses.ts). Issue: the broker's server id (what
// `qorebridge.exe --machine-id` prints there), the features, an expiry; the signed file downloads as qorebridge.license
// and goes next to the bridge's config. Revoke = the kill switch: the bridge stops hedging at its next check (5 min).
type Row = { buildId: string; brokerSubdomain: string; status: "ACTIVE" | "REVOKED"; createdAt: string; version: string; note: string };

export default function BridgeLicenses({ brokerSlug }: { brokerSlug: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [machineId, setMachineId] = useState("");
  const [hedge, setHedge] = useState(true);
  const [feed, setFeed] = useState(false);
  const [days, setDays] = useState("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/bridge-licenses");
    if (r.ok) setRows(((await r.json()) as Row[]).filter((x) => x.brokerSubdomain === brokerSlug && x.version === "license"));
  }, [brokerSlug]);
  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const features = [hedge && "hedge", feed && "feed"].filter(Boolean);
    const r = await fetch("/api/admin/bridge-licenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brokerSlug, machineId: machineId.trim(), features, expiresDays: Number(days) }),
    });
    setBusy(false);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(body.error ?? "Could not issue the license.");
      return;
    }
    const url = URL.createObjectURL(new Blob([body.file], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "qorebridge.license";
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`Issued ${body.licenseId}. Put qorebridge.license next to the bridge's config.`);
    setMachineId("");
    void load();
  }

  async function setStatus(row: Row, status: "ACTIVE" | "REVOKED") {
    setError(null);
    const r = await fetch("/api/admin/client-builds", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buildId: row.buildId, status, note: status === "REVOKED" ? "revoked in Super Admin" : "reinstated in Super Admin" }),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not change the license.");
    void load();
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? <p className="text-xs text-[var(--text-3)]">No licenses issued.</p> : null}
      {rows.map((r) => (
        <div key={r.buildId} className="flex items-center gap-2 text-xs">
          <code className="mono">{r.buildId}</code>
          <Badge tone={r.status === "ACTIVE" ? "success" : "danger"}>{r.status === "ACTIVE" ? "ACTIVE" : "REVOKED"}</Badge>
          <span className="text-[var(--text-3)]">{r.createdAt.slice(0, 10)}</span>
          {r.status === "ACTIVE" ? (
            <Button size="sm" variant="danger" onClick={() => setStatus(r, "REVOKED")}>
              Revoke
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setStatus(r, "ACTIVE")}>
              Reinstate
            </Button>
          )}
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input className="w-[30rem] mono" placeholder="Server id (qorebridge.exe --machine-id)" value={machineId} onChange={(e) => setMachineId(e.target.value)} />
        <label className="text-xs">
          <input type="checkbox" checked={hedge} onChange={(e) => setHedge(e.target.checked)} /> Hedging
        </label>
        <label className="text-xs">
          <input type="checkbox" checked={feed} onChange={(e) => setFeed(e.target.checked)} /> Price feed
        </label>
        <label className="text-xs text-[var(--text-3)]">
          Days
          <Input className="ml-2 w-20" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <Button size="sm" variant="primary" disabled={busy || machineId.trim().length !== 64 || (!hedge && !feed)} onClick={issue}>
          {busy ? "Issuing..." : "Issue license"}
        </Button>
      </div>
      <p className="text-xs text-[var(--text-3)]">A reinstated license needs the bridge service restarted.</p>
      {notice ? <p className="text-xs text-[var(--text-2)]">{notice}</p> : null}
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
