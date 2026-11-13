"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { MoveBroker } from "../engines/EnginesManager";

// Multi-engine control plane (owner 2026-11-13): the broker's engine (Broker.engineId) and its append-only history, in the broker detail.
// Dormant until the engine step: a move is recorded; engines do not read it yet.
type History = { id: string; from: string | null; to: string | null; reason: string; by: string | null; at: string };
type EngineLite = { id: string; name: string; region: string; gatewayUrl: string; status: "PLANNED" | "ACTIVE" | "DRAINING" | "RETIRED"; notes: string; staleAfterSecs: number; lastBeatAt: string | null; lastBeatVersion: string | null; health: "fresh" | "stale" | "never"; brokerCount: number };

export default function BrokerEngine({ brokerId, brokerName }: { brokerId: string; brokerName: string }) {
  const [state, setState] = useState<{ engineId: string | null; history: History[] } | null>(null);
  const [engines, setEngines] = useState<EngineLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch(`/api/admin/brokers/${encodeURIComponent(brokerId)}/engine`), fetch("/api/admin/engines")]);
      if (!a.ok || !b.ok) throw new Error(`request failed (${!a.ok ? a.status : b.status})`);
      setState(await a.json()); setEngines(((await b.json()) as { engines: EngineLite[] }).engines); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [brokerId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <p className="text-sm text-[var(--sell)]">Could not load the engine: {error}</p>;
  if (!state) return <p className="text-sm text-[var(--text-3)]">Loading…</p>;
  const current = engines.find((e) => e.id === state.engineId) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          {current ? (<><span className="font-mono">{current.id}</span> <span className="text-[var(--text-3)]">{current.name} · {current.region}</span> <Badge tone={current.status === "ACTIVE" ? "success" : current.status === "RETIRED" ? "danger" : "neutral"}>{current.status}</Badge></>) : <span className="text-[var(--text-3)]">Not assigned to an engine</span>}
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>{current ? "Move" : "Assign"}</Button>
      </div>
      {state.history.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-[var(--text-3)]">
          {state.history.slice(0, 5).map((h) => <li key={h.id}>{new Date(h.at).toLocaleString()}: {h.from ?? "unassigned"} → {h.to ?? "unassigned"} · {h.reason}{h.by ? ` · ${h.by}` : ""}</li>)}
        </ul>
      ) : null}
      {open ? <MoveBroker broker={{ id: brokerId, name: brokerName }} currentEngine={state.engineId} engines={engines} onClose={() => setOpen(false)} onMoved={() => { setOpen(false); void load(); }} /> : null}
    </div>
  );
}
