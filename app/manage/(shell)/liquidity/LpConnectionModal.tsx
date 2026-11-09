"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormField } from "@/components/ui/FormField";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { plainError } from "@/lib/plain-error";
import {
  changedFields,
  DIALECT_LABEL,
  draftBody,
  draftProblem,
  LP_DIALECTS,
  LP_ROLES,
  LP_TLS_MODES,
  newDraft,
  ROLE_LABEL,
  symbolBody,
  symbolProblem,
  TLS_LABEL,
  type ConnectionDraft,
  type LpDialect,
  type LpRole,
  type LpTls,
  type SymbolDraft,
} from "@/lib/lp-connection-rules";

// Phase 2.1 A.3: an LP's connection, the FIX session the broker's QoreBridge opens to it (GET /api/bridge/config
// serves it to the bridge), and how each symbol trades there. API: /api/manage/lp-connections/* (BROKER_ADMIN); the
// checks are lib/lp-connection-rules.ts, the server's own rules. One provider can have a trading and a prices session.
// No password field (owner decision 2026-11-03): it is set on the bridge server. Timeouts / retries are the platform
// operator's and never shown here.

export type LpConnSymbolRow = {
  id: string;
  symbolId: string;
  symbolName: string;
  venueId: string;
  contractSize: string;
  minUnits: string;
  stepUnits: string;
};

export type LpConnectionRow = {
  id: string;
  liquidityProviderId: string;
  liquidityProviderName: string;
  role: LpRole;
  enabled: boolean;
  host: string;
  port: number;
  senderCompId: string;
  targetCompId: string;
  senderSubId: string | null;
  targetSubId: string | null;
  username: string | null;
  tls: LpTls;
  tlsServerName: string | null;
  dialect: LpDialect;
  heartbeatSecs: number;
  resetSeqOnLogon: boolean;
  symbols: LpConnSymbolRow[];
};

type SymbolOption = { id: string; name: string };

function draftOf(c: LpConnectionRow): ConnectionDraft {
  return {
    role: c.role,
    dialect: c.dialect,
    host: c.host,
    port: String(c.port),
    senderCompId: c.senderCompId,
    targetCompId: c.targetCompId,
    senderSubId: c.senderSubId ?? "",
    targetSubId: c.targetSubId ?? "",
    username: c.username ?? "",
    tls: c.tls,
    tlsServerName: c.tlsServerName ?? "",
    heartbeatSecs: String(c.heartbeatSecs),
    resetSeqOnLogon: c.resetSeqOnLogon,
    enabled: c.enabled,
  };
}

const emptySymbol: SymbolDraft = { venueId: "", contractSize: "", minUnits: "", stepUnits: "" };

async function send(method: string, url: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!r) return { ok: false, json: {} };
  return { ok: r.ok, json: await r.json().catch(() => ({})) };
}

/** A one-line summary for the roster: "Trading · cTrader · On", or "" when the provider has no connection. */
export function connectionSummary(conns: LpConnectionRow[]): string {
  return conns
    .map((c) => `${ROLE_LABEL[c.role]} · ${DIALECT_LABEL[c.dialect]} · ${c.enabled ? "On" : "Off"}`)
    .join(", ");
}

export default function LpConnectionModal({
  provider,
  onClose,
  onChanged,
}: {
  provider: { id: string; name: string } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [conns, setConns] = useState<LpConnectionRow[] | null>(null);
  const [symbols, setSymbols] = useState<SymbolOption[]>([]);
  const [role, setRole] = useState<LpRole>("TRADE");
  const [draft, setDraft] = useState<ConnectionDraft>(newDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // symbol rows: each row's edit draft and last refusal; the add row
  const [rowDrafts, setRowDrafts] = useState<Record<string, SymbolDraft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [addSymbolId, setAddSymbolId] = useState("");
  const [addDraft, setAddDraft] = useState<SymbolDraft>(emptySymbol);
  const [addError, setAddError] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  const current = conns?.find((c) => c.role === role) ?? null;

  const load = useCallback(async () => {
    if (!provider) return;
    const [all, syms] = await Promise.all([
      fetch("/api/manage/lp-connections").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/manage/symbols").then((r) => (r.ok ? r.json() : [])),
    ]);
    setConns((all as LpConnectionRow[]).filter((c) => c.liquidityProviderId === provider.id));
    setSymbols((syms as { symbolId: string; symbolName: string }[]).map((s) => ({ id: s.symbolId, name: s.symbolName })));
  }, [provider]);

  useEffect(() => {
    if (!provider) return;
    setConns(null);
    setRole("TRADE");
    load().catch(() => setConns([]));
  }, [provider, load]);

  // the form follows the chosen session: its saved values, or a new one
  useEffect(() => {
    if (conns === null) return;
    const c = conns.find((x) => x.role === role);
    setDraft(c ? draftOf(c) : { ...newDraft(), role });
    setFormError(null);
    setConfirmDelete(false);
    setRowDrafts({});
    setRowErrors({});
    setAddSymbolId("");
    setAddDraft(emptySymbol);
    setAddError(null);
  }, [conns, role]);

  function edit(patch: Partial<ConnectionDraft>) {
    setDraft((d) => {
      const next = { ...d, ...patch };
      // a new cTrader session has no symbols yet, and the bridge refuses one switched on without them
      if (!current && patch.dialect === "CSERVER") next.enabled = false;
      return next;
    });
  }

  async function save() {
    const problem = draftProblem(draft, current?.symbols.length ?? 0);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    const r = current
      ? await send("PATCH", `/api/manage/lp-connections/${current.id}`, changedFields(current as unknown as Record<string, unknown>, draft))
      : await send("POST", "/api/manage/lp-connections", { ...draftBody(draft), liquidityProviderId: provider!.id });
    setSaving(false);
    if (!r.ok) {
      setFormError(plainError(r.json, "Could not save the connection. Try again.", { audience: "staff" }));
      return;
    }
    await load();
    onChanged();
  }

  async function remove() {
    if (!current) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    const r = await send("DELETE", `/api/manage/lp-connections/${current.id}`);
    setSaving(false);
    if (!r.ok) {
      setFormError(plainError(r.json, "Could not remove the connection. Try again.", { audience: "staff" }));
      return;
    }
    await load();
    onChanged();
  }

  // ---- symbol rows ----

  function rowDraft(s: LpConnSymbolRow): SymbolDraft {
    return rowDrafts[s.id] ?? { venueId: s.venueId, contractSize: s.contractSize, minUnits: s.minUnits, stepUnits: s.stepUnits };
  }
  function rowChanged(s: LpConnSymbolRow): boolean {
    const d = rowDrafts[s.id];
    return !!d && (d.venueId !== s.venueId || d.contractSize !== s.contractSize || d.minUnits !== s.minUnits || d.stepUnits !== s.stepUnits);
  }
  function setRowError(id: string, msg: string | null) {
    setRowErrors((m) => {
      const next = { ...m };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }

  async function saveRow(s: LpConnSymbolRow) {
    if (!current) return;
    const d = rowDraft(s);
    const problem = symbolProblem(d, current.dialect);
    if (problem) {
      setRowError(s.id, problem);
      return;
    }
    setBusyRow(s.id);
    setRowError(s.id, null);
    const r = await send("PATCH", `/api/manage/lp-connections/${current.id}/symbols/${s.id}`, symbolBody(d));
    setBusyRow(null);
    if (!r.ok) {
      setRowError(s.id, plainError(r.json, "Could not save the symbol. Try again.", { audience: "staff" }));
      return;
    }
    await load();
    onChanged();
  }

  async function removeRow(s: LpConnSymbolRow) {
    if (!current) return;
    setBusyRow(s.id);
    setRowError(s.id, null);
    const r = await send("DELETE", `/api/manage/lp-connections/${current.id}/symbols/${s.id}`);
    setBusyRow(null);
    if (!r.ok) {
      setRowError(s.id, plainError(r.json, "Could not remove the symbol. Try again.", { audience: "staff" }));
      return;
    }
    await load();
    onChanged();
  }

  /** The platform's contract size and the broker's minimum lot / lot step, in units (GET symbol-defaults). */
  async function fillDefaults() {
    if (!addSymbolId) {
      setAddError("Choose a symbol first");
      return;
    }
    setFilling(true);
    setAddError(null);
    const r = await send("GET", `/api/manage/lp-connections/symbol-defaults?symbolId=${encodeURIComponent(addSymbolId)}`);
    setFilling(false);
    if (!r.ok) {
      setAddError(plainError(r.json, "Could not load the defaults. Try again.", { audience: "staff" }));
      return;
    }
    const j = r.json as { symbolName?: string; contractSize?: string; minUnits?: string; stepUnits?: string };
    setAddDraft((d) => ({
      // a FIX 4.4 venue usually names the symbol as the platform does; a cTrader one needs its numeric id from the LP
      venueId: d.venueId || (current?.dialect === "CSERVER" ? "" : (j.symbolName ?? "")),
      contractSize: j.contractSize ?? d.contractSize,
      minUnits: j.minUnits ?? d.minUnits,
      stepUnits: j.stepUnits ?? d.stepUnits,
    }));
  }

  async function addRow() {
    if (!current) return;
    if (!addSymbolId) {
      setAddError("Choose a symbol first");
      return;
    }
    const problem = symbolProblem(addDraft, current.dialect);
    if (problem) {
      setAddError(problem);
      return;
    }
    setBusyRow("new");
    setAddError(null);
    const r = await send("POST", `/api/manage/lp-connections/${current.id}/symbols`, { symbolId: addSymbolId, ...symbolBody(addDraft) });
    setBusyRow(null);
    if (!r.ok) {
      setAddError(plainError(r.json, "Could not add the symbol. Try again.", { audience: "staff" }));
      return;
    }
    await load();
    onChanged();
  }

  const mapped = new Set(current?.symbols.map((s) => s.symbolId) ?? []);
  const cserver = (current?.dialect ?? draft.dialect) === "CSERVER";

  return (
    <Modal open={provider !== null} onClose={onClose} title={provider ? `Connection: ${provider.name}` : "Connection"} xl>
      {conns === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2">
            {LP_ROLES.map((r) => {
              const has = conns.some((c) => c.role === r);
              return (
                <Button key={r} size="sm" variant={role === r ? "primary" : "secondary"} onClick={() => setRole(r)}>
                  {ROLE_LABEL[r]} session{has ? "" : " (none)"}
                </Button>
              );
            })}
            {current ? <Badge tone={current.enabled ? "success" : "neutral"}>{current.enabled ? "On" : "Off"}</Badge> : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="flex flex-col gap-3"
          >
            <div className="grid grid-cols-4 gap-3">
              <FormField label="Type">
                <Select value={draft.dialect} onChange={(e) => edit({ dialect: e.target.value as LpDialect })} aria-label="Type">
                  {LP_DIALECTS.map((d) => (
                    <option key={d} value={d}>
                      {DIALECT_LABEL[d]}
                    </option>
                  ))}
                </Select>
              </FormField>
              <div className="col-span-2">
                <FormField label="Host">
                  <Input value={draft.host} onChange={(e) => edit({ host: e.target.value })} placeholder="fix.provider.com" mono aria-label="Host" />
                </FormField>
              </div>
              <FormField label="Port">
                <Input value={draft.port} onChange={(e) => edit({ port: e.target.value })} inputMode="numeric" mono aria-label="Port" />
              </FormField>
              <FormField label="SenderCompID">
                <Input value={draft.senderCompId} onChange={(e) => edit({ senderCompId: e.target.value })} mono aria-label="SenderCompID" />
              </FormField>
              <FormField label="TargetCompID">
                <Input value={draft.targetCompId} onChange={(e) => edit({ targetCompId: e.target.value })} mono aria-label="TargetCompID" />
              </FormField>
              <FormField label="SenderSubID (optional)">
                <Input value={draft.senderSubId} onChange={(e) => edit({ senderSubId: e.target.value })} mono aria-label="SenderSubID" />
              </FormField>
              <FormField label="TargetSubID (optional)">
                <Input value={draft.targetSubId} onChange={(e) => edit({ targetSubId: e.target.value })} mono aria-label="TargetSubID" />
              </FormField>
              <FormField label="Username (optional)">
                <Input value={draft.username} onChange={(e) => edit({ username: e.target.value })} mono aria-label="Username" />
              </FormField>
              <FormField label="Password">
                <p className="flex h-[38px] items-center text-xs text-[var(--text-3)]">Set on your QoreBridge server, never stored here</p>
              </FormField>
              <FormField label="TLS">
                <Select value={draft.tls} onChange={(e) => edit({ tls: e.target.value as LpTls })} aria-label="TLS">
                  {LP_TLS_MODES.map((t) => (
                    <option key={t} value={t}>
                      {TLS_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="TLS server name (optional)">
                <Input
                  value={draft.tlsServerName}
                  onChange={(e) => edit({ tlsServerName: e.target.value })}
                  disabled={draft.tls === "OFF"}
                  mono
                  aria-label="TLS server name"
                />
              </FormField>
              <FormField label="Heartbeat (seconds)">
                <Input value={draft.heartbeatSecs} onChange={(e) => edit({ heartbeatSecs: e.target.value })} inputMode="numeric" mono aria-label="Heartbeat" />
              </FormField>
              <FormField label="Options">
                <div className="flex h-[38px] items-center">
                  <Checkbox checked={draft.resetSeqOnLogon} onChange={(e) => edit({ resetSeqOnLogon: e.target.checked })} label="Reset sequence on logon" />
                </div>
              </FormField>
              <FormField label="Status">
                <div className="flex h-[38px] items-center">
                  <Checkbox checked={draft.enabled} onChange={(e) => edit({ enabled: e.target.checked })} label="Switched on" />
                </div>
              </FormField>
            </div>
            <p className="text-xs text-[var(--text-3)]">
              A change reaches the bridge when it restarts. {cserver && !current ? "Save the cTrader session, add its symbols, then switch it on." : ""}
            </p>
            {formError ? <p className="text-sm text-[var(--sell)]">{formError}</p> : null}
            <div className="flex items-center justify-between">
              {current ? (
                <Button variant={confirmDelete ? "danger" : "ghost"} size="sm" disabled={saving} onClick={remove}>
                  {confirmDelete ? "Confirm remove" : "Remove connection"}
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Saving..." : current ? "Save changes" : "Add connection"}
              </Button>
            </div>
          </form>

          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-[var(--text-1)]">Symbols at the provider</p>
            {!current ? (
              <p className="text-sm text-[var(--text-3)]">Add the connection first, then map its symbols.</p>
            ) : (
              <>
                <p className="text-xs text-[var(--text-3)]">
                  Sizes are in units (1 lot = the contract size). {cserver ? "A cTrader venue symbol is its numeric symbol id." : ""}
                </p>
                <Table>
                  <TableHead>
                    <TableHeaderCell>Symbol</TableHeaderCell>
                    <TableHeaderCell>Venue symbol</TableHeaderCell>
                    <TableHeaderCell align="right">Contract size</TableHeaderCell>
                    <TableHeaderCell align="right">Minimum</TableHeaderCell>
                    <TableHeaderCell align="right">Step</TableHeaderCell>
                    <TableHeaderCell />
                  </TableHead>
                  <TableBody>
                    {current.symbols.length === 0 ? (
                      <TableEmptyState colSpan={6}>No symbols mapped yet.</TableEmptyState>
                    ) : (
                      current.symbols.map((s) => {
                        const d = rowDraft(s);
                        const set = (patch: Partial<SymbolDraft>) => setRowDrafts((m) => ({ ...m, [s.id]: { ...d, ...patch } }));
                        const busy = busyRow === s.id;
                        return (
                          <TableRow key={s.id}>
                            <TableCell mono>
                              {s.symbolName}
                              {rowErrors[s.id] ? <div className="mt-1 font-sans text-xs text-[var(--sell)]">{rowErrors[s.id]}</div> : null}
                            </TableCell>
                            <TableCell>
                              <Input value={d.venueId} onChange={(e) => set({ venueId: e.target.value })} disabled={busy} mono aria-label="Venue symbol" />
                            </TableCell>
                            <TableCell align="right">
                              <Input value={d.contractSize} onChange={(e) => set({ contractSize: e.target.value })} disabled={busy} mono className="text-right" aria-label="Contract size" />
                            </TableCell>
                            <TableCell align="right">
                              <Input value={d.minUnits} onChange={(e) => set({ minUnits: e.target.value })} disabled={busy} mono className="text-right" aria-label="Minimum" />
                            </TableCell>
                            <TableCell align="right">
                              <Input value={d.stepUnits} onChange={(e) => set({ stepUnits: e.target.value })} disabled={busy} mono className="text-right" aria-label="Step" />
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                {rowChanged(s) ? (
                                  <Button size="sm" variant="primary" disabled={busy} onClick={() => saveRow(s)}>
                                    Save
                                  </Button>
                                ) : null}
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => removeRow(s)}>
                                  Remove
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                    <TableRow>
                      <TableCell>
                        <Select value={addSymbolId} onChange={(e) => setAddSymbolId(e.target.value)} aria-label="New symbol" className="min-w-[8rem]">
                          <option value="">Add symbol...</option>
                          {symbols
                            .filter((o) => !mapped.has(o.id))
                            .map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={addDraft.venueId}
                          onChange={(e) => setAddDraft((d) => ({ ...d, venueId: e.target.value }))}
                          placeholder={cserver ? "e.g. 41" : "e.g. EURUSD"}
                          mono
                          aria-label="New venue symbol"
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Input value={addDraft.contractSize} onChange={(e) => setAddDraft((d) => ({ ...d, contractSize: e.target.value }))} mono className="text-right" aria-label="New contract size" />
                      </TableCell>
                      <TableCell align="right">
                        <Input value={addDraft.minUnits} onChange={(e) => setAddDraft((d) => ({ ...d, minUnits: e.target.value }))} mono className="text-right" aria-label="New minimum" />
                      </TableCell>
                      <TableCell align="right">
                        <Input value={addDraft.stepUnits} onChange={(e) => setAddDraft((d) => ({ ...d, stepUnits: e.target.value }))} mono className="text-right" aria-label="New step" />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="secondary" disabled={filling || !addSymbolId} onClick={fillDefaults} className="whitespace-nowrap">
                            {filling ? "Filling..." : "Fill defaults"}
                          </Button>
                          <Button size="sm" variant="primary" disabled={busyRow === "new"} onClick={addRow}>
                            Add
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                {addError ? <p className="text-sm text-[var(--sell)]">{addError}</p> : null}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
