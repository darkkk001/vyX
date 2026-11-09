"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";

// QoreBridge licenses for one broker (owner 2026-10-23, lib/bridge-licenses.ts). Issue: the broker's server id (what
// `qorebridge.exe --machine-id` prints there), the features, an expiry; the signed file downloads as qorebridge.license
// and goes next to the bridge's config.
// License enforcement 1.2 (2026-11-09): Suspend (reversible, reason required: no new hedges, closes still go out),
// Resume, Revoke (permanent: only a new license brings the bridge back). Each asks for confirmation first. The bridge
// acts within about 15 s (its next status report), sooner through the nudge.
type Row = {
  buildId: string;
  brokerSubdomain: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  createdAt: string;
  revokedAt: string | null;
  version: string;
  note: string;
  expiresAt: string | null;
  expiry: "expired" | "expiring" | "ok" | null;
  features: string[];
  suspendReason: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  revokeReason: string | null;
  revokedBy: string | null;
  machine: { prefix: string; source: "issued" | "first-report" } | null;
  online: { online: boolean; lastReportAt: string | null; machine: string | null };
  conflict: { machine: string; at: string | null } | null;
};

type Pending = { row: Row; action: "suspend" | "resume" | "revoke" };
const REASON_MAX = 200;
const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "");

const STATUS_TONE: Record<Row["status"], "success" | "warning" | "danger"> = { ACTIVE: "success", SUSPENDED: "warning", REVOKED: "danger" };

const CONFIRM_TEXT: Record<Pending["action"], { title: string; body: string; button: string }> = {
  suspend: {
    title: "Suspend this license?",
    body: "The bridge stops sending new hedges within about 15 seconds. Closing existing hedges still works and the LP session stays logged on. You can resume it later.",
    button: "Suspend license",
  },
  resume: { title: "Resume this license?", body: "The bridge sends new hedges again within about 15 seconds, without a restart.", button: "Resume license" },
  revoke: {
    title: "Revoke this license permanently?",
    body: "The bridge stops and logs off the LP. A revoked license can never be reinstated: the broker needs a new license. Open hedges stay on the LP.",
    button: "Revoke permanently",
  },
};

export default function BridgeLicenses({ brokerSlug }: { brokerSlug: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [machineId, setMachineId] = useState("");
  const [hedge, setHedge] = useState(true);
  const [feed, setFeed] = useState(false);
  const [days, setDays] = useState("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");

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

  function ask(row: Row, action: Pending["action"]) {
    setError(null);
    setNotice(null);
    setReason("");
    setPending({ row, action });
  }

  const reasonRequired = pending?.action === "suspend" || pending?.action === "revoke";
  const reasonOk = reason.trim().length <= REASON_MAX && (!reasonRequired || reason.trim().length > 0);

  async function confirm() {
    if (!pending || !reasonOk) return;
    setBusy(true);
    const r = await fetch(`/api/admin/bridge-licenses/${encodeURIComponent(pending.row.buildId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: pending.action, reason: reason.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error ?? "Could not change the license.");
    } else {
      setNotice(`${pending.row.buildId}: ${pending.action === "suspend" ? "suspended" : pending.action === "resume" ? "resumed" : "revoked"}.`);
    }
    setPending(null);
    void load();
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? <p className="text-xs text-[var(--text-3)]">No licenses issued.</p> : null}
      {rows.map((r) => (
        <div key={r.buildId} className="flex flex-col gap-1 rounded border border-[var(--border)] p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <code className="mono">{r.buildId}</code>
            <Badge tone={STATUS_TONE[r.status] ?? "danger"}>{r.status}</Badge>
            <Badge tone={r.online.online ? "success" : "neutral"}>{r.online.online ? "Online" : "Offline"}</Badge>
            <span className="text-[var(--text-3)]">issued {r.createdAt.slice(0, 10)}</span>
            {r.expiresAt ? <span className="text-[var(--text-3)]">expires {r.expiresAt.slice(0, 10)}</span> : <span className="text-[var(--text-3)]">expiry unknown</span>}
            {r.expiry === "expiring" ? <Badge tone="warning">Expires within 30 days: issue a new license</Badge> : null}
            {r.expiry === "expired" ? <Badge tone="danger">Expired</Badge> : null}
            <span className="text-[var(--text-3)]">features: {r.features.length ? r.features.join(", ") : "unknown"}</span>
            <span className="ml-auto flex gap-1">
              {r.status === "ACTIVE" ? (
                <Button size="sm" variant="ghost" onClick={() => ask(r, "suspend")}>
                  Suspend
                </Button>
              ) : null}
              {r.status === "SUSPENDED" ? (
                <Button size="sm" variant="ghost" onClick={() => ask(r, "resume")}>
                  Resume
                </Button>
              ) : null}
              {r.status !== "REVOKED" ? (
                <Button size="sm" variant="danger" onClick={() => ask(r, "revoke")}>
                  Revoke
                </Button>
              ) : null}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-3)]">
            <span>
              Server: {r.machine ? <code className="mono">{r.machine.prefix}</code> : "not bound yet"}
              {r.machine?.source === "first-report" ? " (bound at its first report)" : ""}
            </span>
            <span>
              Last report: {r.online.lastReportAt ? when(r.online.lastReportAt) : "never"}
              {r.online.machine ? (
                <>
                  {" "}
                  from <code className="mono">{r.online.machine}</code>
                </>
              ) : null}
            </span>
          </div>
          {r.status === "SUSPENDED" ? (
            <p className="text-[var(--warn)]">
              Suspended {when(r.suspendedAt)}
              {r.suspendedBy ? ` by ${r.suspendedBy}` : ""}: {r.suspendReason || "no reason recorded"}
            </p>
          ) : null}
          {r.status === "REVOKED" ? (
            <p className="text-[var(--sell)]">
              Revoked {when(r.revokedAt)}
              {r.revokedBy ? ` by ${r.revokedBy}` : ""}
              {r.revokeReason ? `: ${r.revokeReason}` : ""}. A revoked license cannot be reinstated.
            </p>
          ) : null}
          {r.conflict ? (
            <p className="text-[var(--sell)]">
              Another server tried to use this license: <code className="mono">{r.conflict.machine}</code> {when(r.conflict.at)}. It was refused.
            </p>
          ) : null}
        </div>
      ))}

      {pending ? (
        <div role="alertdialog" aria-modal="true" aria-labelledby="bl-confirm-title" className="flex flex-col gap-2 rounded border border-[var(--border)] bg-[var(--bg-2)] p-3 text-xs">
          <p id="bl-confirm-title" className="text-sm font-semibold text-[var(--text-1)]">
            {CONFIRM_TEXT[pending.action].title}
          </p>
          <p className="text-[var(--text-2)]">
            <code className="mono">{pending.row.buildId}</code>. {CONFIRM_TEXT[pending.action].body}
          </p>
          <label className="flex flex-col gap-1 text-[var(--text-3)]">
            Reason {reasonRequired ? "(required)" : "(optional)"}, shown to the broker&apos;s dealers
            <Input value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="Why" />
            <span>
              {reason.trim().length}/{REASON_MAX}
            </span>
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant={pending.action === "revoke" ? "danger" : "primary"} disabled={busy || !reasonOk} onClick={confirm}>
              {busy ? "Saving..." : CONFIRM_TEXT[pending.action].button}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

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
      {notice ? <p className="text-xs text-[var(--text-2)]">{notice}</p> : null}
      {error ? <p className="text-xs text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
