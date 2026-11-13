"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Table, TableBody, TableCell, TableEmptyState, TableHead, TableHeaderCell, TableRow } from "@/components/ui/Table";

// Multi-engine control plane (owner 2026-11-13). Health is the engine's own heartbeat only (no gateway probe). Dormant until the engine step:
// engines do not read their assignment yet, so a move here changes the record, not what any engine serves today.

type Status = "PLANNED" | "ACTIVE" | "DRAINING" | "RETIRED";
type Engine = { id: string; name: string; region: string; gatewayUrl: string; status: Status; notes: string; staleAfterSecs: number; lastBeatAt: string | null; lastBeatVersion: string | null; health: "fresh" | "stale" | "never"; brokerCount: number };
type RosterRow = { id: string; name: string; subdomain: string; status: string; riskAuthority: string; accounts: number; served: boolean };
type Move = { id: string; brokerId: string; from: string | null; to: string | null; reason: string; at: string };
const STATUSES: Status[] = ["PLANNED", "ACTIVE", "DRAINING", "RETIRED"];
const statusTone = (s: Status) => (s === "ACTIVE" ? "success" : s === "DRAINING" ? "warning" : s === "RETIRED" ? "danger" : "neutral") as "success" | "warning" | "danger" | "neutral";
const healthTone = (h: Engine["health"]) => (h === "fresh" ? "success" : h === "stale" ? "danger" : "neutral") as "success" | "danger" | "neutral";

function age(iso: string | null): string {
  if (!iso) return "no heartbeat yet";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `request failed (${r.status})`);
  return body as T;
}

export default function EnginesManager() {
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [unassigned, setUnassigned] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Engine | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await call<{ engines: Engine[]; unassignedBrokers: number }>("/api/admin/engines");
      setEngines(d.engines); setUnassigned(d.unassignedBrokers); setError(null);
      setSelected((cur) => cur ?? d.engines[0]?.id ?? null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-sm text-[var(--sell)]">Could not load the engines: {error}</p> : null}
      <Table title="Engines" description={`${unassigned} broker${unassigned === 1 ? "" : "s"} not assigned to an engine`} action={<Button variant="primary" size="sm" onClick={() => setEditing("new")}>Add engine</Button>}>
        <TableHead>
          <TableHeaderCell>Engine</TableHeaderCell>
          <TableHeaderCell>Region</TableHeaderCell>
          <TableHeaderCell>Gateway</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Heartbeat</TableHeaderCell>
          <TableHeaderCell align="right">Brokers</TableHeaderCell>
        </TableHead>
        <TableBody>
          {engines === null ? <TableEmptyState colSpan={6}>Loading…</TableEmptyState> : engines.length === 0 ? <TableEmptyState colSpan={6}>No engine registered yet.</TableEmptyState> : engines.map((e) => (
            <TableRow key={e.id} onClick={() => setSelected(e.id)} className={`cursor-pointer ${selected === e.id ? "bg-[var(--bg-3)]" : ""}`}>
              <TableCell primary><span className="font-mono">{e.id}</span> <span className="text-[var(--text-3)]">{e.name}</span></TableCell>
              <TableCell>{e.region}</TableCell>
              <TableCell mono>{e.gatewayUrl.replace(/^https:\/\//, "")}</TableCell>
              <TableCell><Badge tone={statusTone(e.status)}>{e.status}</Badge></TableCell>
              <TableCell><Badge tone={healthTone(e.health)}>{e.health === "never" ? "NONE" : e.health.toUpperCase()}</Badge> <span className="text-xs text-[var(--text-3)]">{age(e.lastBeatAt)}</span></TableCell>
              <TableCell align="right" mono>{e.brokerCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selected ? <EngineDetail key={selected} id={selected} engines={engines ?? []} onEdit={(e) => setEditing(e)} onChanged={load} /> : null}
      {editing ? <EngineForm engine={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} /> : null}
    </div>
  );
}

function EngineDetail({ id, engines, onEdit, onChanged }: { id: string; engines: Engine[]; onEdit: (e: Engine) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ engine: Engine; roster: RosterRow[]; moves: Move[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<RosterRow | null>(null);
  const load = useCallback(async () => {
    try { setData(await call(`/api/admin/engines/${encodeURIComponent(id)}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <p className="text-sm text-[var(--sell)]">Could not load {id}: {error}</p>;
  if (!data) return <p className="text-sm text-[var(--text-3)]">Loading {id}…</p>;
  const names = new Map(data.roster.map((r) => [r.id, r.name]));
  return (
    <div className="flex flex-col gap-4">
      <Table
        title={`${data.engine.name} (${data.engine.id})`}
        description={data.engine.status === "ACTIVE" || data.engine.status === "DRAINING" ? "Brokers on this engine. Served = what the engine reads by its ENGINE_ID." : `${data.engine.status}: this engine serves no broker.`}
        action={<Button size="sm" onClick={() => onEdit(data.engine)}>Edit engine</Button>}
      >
        <TableHead>
          <TableHeaderCell>Broker</TableHeaderCell>
          <TableHeaderCell>Host</TableHeaderCell>
          <TableHeaderCell>Risk owner</TableHeaderCell>
          <TableHeaderCell align="right">Accounts</TableHeaderCell>
          <TableHeaderCell>Served</TableHeaderCell>
          <TableHeaderCell align="right"> </TableHeaderCell>
        </TableHead>
        <TableBody>
          {data.roster.length === 0 ? <TableEmptyState colSpan={6}>No broker on this engine.</TableEmptyState> : data.roster.map((r) => (
            <TableRow key={r.id}>
              <TableCell primary>{r.name}</TableCell>
              <TableCell mono>{r.subdomain}</TableCell>
              <TableCell><Badge tone={r.riskAuthority === "RUST" ? "accent" : "neutral"}>{r.riskAuthority === "RUST" ? "ENGINE" : "WEB"}</Badge></TableCell>
              <TableCell align="right" mono>{r.accounts}</TableCell>
              <TableCell><Badge tone={r.served ? "success" : "neutral"}>{r.served ? "YES" : "NO"}</Badge></TableCell>
              <TableCell align="right"><Button size="sm" onClick={() => setMoving(r)}>Move</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.moves.length > 0 ? (
        <div className="text-xs text-[var(--text-3)]">
          <p className="mb-1 font-semibold uppercase tracking-wide">Recent moves</p>
          <ul className="flex flex-col gap-1">
            {data.moves.slice(0, 10).map((m) => (
              <li key={m.id}>{new Date(m.at).toLocaleString()}: {names.get(m.brokerId) ?? m.brokerId} {m.from ?? "unassigned"} → {m.to ?? "unassigned"} · {m.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {moving ? <MoveBroker broker={moving} currentEngine={id} engines={engines} onClose={() => setMoving(null)} onMoved={() => { setMoving(null); void load(); onChanged(); }} /> : null}
    </div>
  );
}

export function MoveBroker({ broker, currentEngine, engines, onClose, onMoved }: { broker: { id: string; name: string }; currentEngine: string | null; engines: Engine[]; onClose: () => void; onMoved: () => void }) {
  const [target, setTarget] = useState<string>(currentEngine ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = (target || null) !== currentEngine;
  async function save() {
    setBusy(true); setError(null);
    try {
      await call(`/api/admin/brokers/${encodeURIComponent(broker.id)}/engine`, { method: "PUT", body: JSON.stringify({ engineId: target || null, reason }) });
      onMoved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Engine for ${broker.name}`} onSubmit={() => { if (changed && reason.trim().length >= 3) void save(); }}>
      <div className="flex flex-col gap-4">
        <FormField label="Engine">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Not assigned</option>
            {engines.filter((e) => e.status !== "RETIRED" || e.id === currentEngine).map((e) => <option key={e.id} value={e.id}>{e.id} · {e.name} ({e.status.toLowerCase()})</option>)}
          </Select>
        </FormField>
        <FormField label="Reason (kept in the history)" error={error}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this broker moves" maxLength={500} />
        </FormField>
        <p className="text-xs text-[var(--text-3)]">Recorded now; engines start reading their assignment with the engine release.</p>
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!changed || reason.trim().length < 3 || busy}>{busy ? "Saving…" : "Save"}</Button>
        </ModalActions>
      </div>
    </Modal>
  );
}

function EngineForm({ engine, onClose, onSaved }: { engine: Engine | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ id: engine?.id ?? "", name: engine?.name ?? "", region: engine?.region ?? "", gatewayUrl: engine?.gatewayUrl ?? "https://", status: engine?.status ?? ("PLANNED" as Status), staleAfterSecs: String(engine?.staleAfterSecs ?? 30), notes: engine?.notes ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    setBusy(true); setError(null);
    const body = { name: f.name, region: f.region, gatewayUrl: f.gatewayUrl, status: f.status, staleAfterSecs: Number(f.staleAfterSecs), notes: f.notes, ...(engine ? {} : { id: f.id }) };
    try {
      await call(engine ? `/api/admin/engines/${encodeURIComponent(engine.id)}` : "/api/admin/engines", { method: engine ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={engine ? `Edit ${engine.id}` : "Add engine"} onSubmit={() => void save()}>
      <div className="flex flex-col gap-4">
        {engine ? null : <FormField label="Engine id (its ENGINE_ID, e.g. eu-de-1)"><Input value={f.id} onChange={set("id")} mono /></FormField>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Name"><Input value={f.name} onChange={set("name")} /></FormField>
          <FormField label="Region"><Input value={f.region} onChange={set("region")} /></FormField>
        </div>
        <FormField label="Gateway URL"><Input value={f.gatewayUrl} onChange={set("gatewayUrl")} mono /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Status">
            <Select value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value as Status }))}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
          </FormField>
          <FormField label="Heartbeat counts as stale after (s)"><Input value={f.staleAfterSecs} onChange={set("staleAfterSecs")} inputMode="numeric" /></FormField>
        </div>
        <FormField label="Notes" error={error}><Input value={f.notes} onChange={set("notes")} /></FormField>
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </ModalActions>
      </div>
    </Modal>
  );
}
