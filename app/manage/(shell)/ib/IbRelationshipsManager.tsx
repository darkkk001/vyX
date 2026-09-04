"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type IbRelationshipRow = {
  id: string;
  ibAccountId: string;
  ibAccountNumber: string;
  ibAccountFullName: string;
  clientAccountId: string;
  clientAccountNumber: string;
  clientAccountFullName: string;
  commissionType: "PER_LOT" | "PERCENTAGE";
  commissionRate: string;
  pendingCommission: string;
  lastPayoutAt: string | null;
};

export type AccountOption = { id: string; accountNumber: string; fullName: string };

type AccountLite = { id: string; accountNumber: string; fullName: string; status: string; hasIbLink: boolean };

// Multi-level chains are already representable in the data (any account
// can be an IB for others while also being someone else's client -- see
// app/manage/(shell)/ib/page.tsx's own comment) -- this just visualizes
// the existing flat rows as a tree instead of computing anything new.
// Roots = ibAccountId values that never appear as a clientAccountId.
// visited guards against a pathological loop (nothing in the schema
// forbids one, even though normal use never creates it).
function HierarchyView({ rows }: { rows: IbRelationshipRow[] }) {
  const byIb = new Map<string, IbRelationshipRow[]>();
  for (const r of rows) {
    if (!byIb.has(r.ibAccountId)) byIb.set(r.ibAccountId, []);
    byIb.get(r.ibAccountId)!.push(r);
  }
  const clientIds = new Set(rows.map((r) => r.clientAccountId));
  const roots = [...byIb.keys()].filter((ibId) => !clientIds.has(ibId));

  function renderNode(ibId: string, label: string, visited: Set<string>, depth: number): React.ReactNode {
    if (visited.has(ibId)) return null;
    const next = new Set(visited).add(ibId);
    const children = byIb.get(ibId) ?? [];
    return (
      <div key={ibId} style={{ marginLeft: depth * 20 }} className="mt-1.5">
        <div className="text-sm font-semibold text-[var(--text-1)]">{label}</div>
        {children.map((c) => (
          <div key={c.id} className="mt-1" style={{ marginLeft: 20 }}>
            <div className="text-sm text-[var(--text-2)]">
              → {c.clientAccountNumber}, {c.clientAccountFullName}{" "}
              <span className="text-xs text-[var(--text-3)]">
                ({c.commissionType === "PER_LOT" ? `$${c.commissionRate}/lot` : `${c.commissionRate}%`}, pending {c.pendingCommission})
              </span>
            </div>
            {byIb.has(c.clientAccountId) ? renderNode(c.clientAccountId, `${c.clientAccountNumber}, ${c.clientAccountFullName} (as IB)`, next, depth + 2) : null}
          </div>
        ))}
      </div>
    );
  }

  if (roots.length === 0) {
    return <p className="text-sm text-[var(--text-3)]">No IB relationships.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {roots.map((ibId) => {
        const first = byIb.get(ibId)![0];
        return renderNode(ibId, `${first.ibAccountNumber}, ${first.ibAccountFullName}`, new Set(), 0);
      })}
    </div>
  );
}

// Create-form + editable table. Self-fetches from the already-existing
// /api/manage/ib-relationships GET and /api/manage/accounts GET (the
// latter extended with hasIbLink) instead of receiving both as
// server-rendered props -- both the website and a bundled manager-shell
// desktop app share this one path now. router.refresh() calls replaced
// with a local reload() that re-fetches both.
export default function IbRelationshipsManager() {
  const [rows, setRows] = useState<IbRelationshipRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [view, setView] = useState<"flat" | "hierarchy">("flat");

  // Any ACTIVE account can be an IB (even one that already has clients of
  // its own). Only accounts with no existing IB link can be picked as a
  // new client -- clientAccountId is @unique, so offering an
  // already-linked account here would just be a guaranteed 409.
  const ibOptions: AccountOption[] = accounts
    .filter((a) => a.status === "ACTIVE")
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));
  const clientOptions: AccountOption[] = accounts
    .filter((a) => a.status === "ACTIVE" && !a.hasIbLink)
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));

  function reload() {
    return Promise.all([
      fetch("/api/manage/ib-relationships")
        .then((r) => r.json())
        .then((d: (IbRelationshipRow & { lastPayoutAt: string | null })[]) =>
          setRows(d.map((r) => ({ ...r, lastPayoutAt: r.lastPayoutAt ? formatDateTime(r.lastPayoutAt) : null })))
        ),
      fetch("/api/manage/accounts")
        .then((r) => r.json())
        .then(setAccounts),
    ]);
  }

  useEffect(() => {
    reload().catch(() => setRows([]));
  }, []);

  // --- Create form ---
  const [ibAccountId, setIbAccountId] = useState("");
  const [clientAccountId, setClientAccountId] = useState("");
  const [commissionType, setCommissionType] = useState<"PER_LOT" | "PERCENTAGE">("PER_LOT");
  const [commissionRate, setCommissionRate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!ibAccountId && ibOptions[0]) setIbAccountId(ibOptions[0].id);
    if (!clientAccountId && clientOptions[0]) setClientAccountId(clientOptions[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  async function createRelationship(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const response = await fetch("/api/manage/ib-relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ibAccountId, clientAccountId, commissionType, commissionRate }),
    });
    setCreating(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setCreateError(body.error ?? "failed to create relationship");
      return;
    }
    setCommissionRate("");
    setClientAccountId("");
    reload().catch(() => {});
  }

  // --- Per-row rate/type edit ---
  const [draftType, setDraftType] = useState<Record<string, "PER_LOT" | "PERCENTAGE">>({});
  const [draftRate, setDraftRate] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  async function saveEdit(row: IbRelationshipRow) {
    setSavingId(row.id);
    setSavedId(null);
    setEditErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/ib-relationships/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commissionType: draftType[row.id] ?? row.commissionType,
        commissionRate: draftRate[row.id] ?? row.commissionRate,
      }),
    });
    setSavingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setEditErrors((prev) => ({ ...prev, [row.id]: body.error ?? "save failed" }));
      return;
    }
    setSavedId(row.id);
    reload().catch(() => {});
  }

  // --- Pay action ---
  const [payTarget, setPayTarget] = useState<IbRelationshipRow | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payErrors, setPayErrors] = useState<Record<string, string>>({});

  async function pay(row: IbRelationshipRow) {
    setPayingId(row.id);
    setPayErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/ib-relationships/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "PAY" }),
    });
    setPayingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setPayErrors((prev) => ({ ...prev, [row.id]: body.error ?? "payout failed" }));
      setPayTarget(null);
      return;
    }
    setPayTarget(null);
    reload().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-[var(--text-3)]">
        {rows.length} relationship{rows.length === 1 ? "" : "s"}. Pending commission is calculated from each client&apos;s closed trades since the last payout.
      </p>
      <Card title="Add a relationship">
        <form onSubmit={createRelationship} className="flex flex-wrap items-center gap-2">
          <Select value={ibAccountId} onChange={(e) => setIbAccountId(e.target.value)} required className="w-56">
            {ibOptions.map((a) => (
              <option key={a.id} value={a.id}>
                IB: {a.accountNumber}, {a.fullName}
              </option>
            ))}
          </Select>
          <Select value={clientAccountId} onChange={(e) => setClientAccountId(e.target.value)} required className="w-56">
            {clientOptions.length === 0 ? (
              <option value="">No unlinked accounts</option>
            ) : (
              clientOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  Client: {a.accountNumber}, {a.fullName}
                </option>
              ))
            )}
          </Select>
          <Select value={commissionType} onChange={(e) => setCommissionType(e.target.value as "PER_LOT" | "PERCENTAGE")} className="w-40">
            <option value="PER_LOT">Per lot ($)</option>
            <option value="PERCENTAGE">Percentage (%)</option>
          </Select>
          <Input
            type="text"
            inputMode="decimal"
            mono
            value={commissionRate}
            onChange={(e) => setCommissionRate(e.target.value)}
            placeholder="Rate"
            className="w-20"
            required
          />
          <Button type="submit" variant="primary" disabled={creating || !ibAccountId || !clientAccountId}>
            {creating ? "Adding..." : "Add"}
          </Button>
          {createError ? <span className="text-sm text-[var(--sell)]">{createError}</span> : null}
        </form>
      </Card>

      <Card
        title="Relationships"
        action={
          <div className="flex gap-1.5">
            <Button size="sm" variant={view === "flat" ? "primary" : "ghost"} onClick={() => setView("flat")}>
              Flat list
            </Button>
            <Button size="sm" variant={view === "hierarchy" ? "primary" : "ghost"} onClick={() => setView("hierarchy")}>
              Hierarchy
            </Button>
          </div>
        }
      >
        {view === "hierarchy" ? (
          <div className="p-[18px]">
            <HierarchyView rows={rows} />
          </div>
        ) : (
        <Table>
          <TableHead>
            <TableHeaderCell>IB</TableHeaderCell>
            <TableHeaderCell>Client</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell align="right">Rate</TableHeaderCell>
            <TableHeaderCell align="right">Pending</TableHeaderCell>
            <TableHeaderCell>Last payout</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={7}>No IB relationships.</TableEmptyState>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.ibAccountNumber}
                    <div className="text-xs text-[var(--text-3)]">{row.ibAccountFullName}</div>
                  </TableCell>
                  <TableCell>
                    {row.clientAccountNumber}
                    <div className="text-xs text-[var(--text-3)]">{row.clientAccountFullName}</div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={draftType[row.id] ?? row.commissionType}
                      onChange={(e) => setDraftType((prev) => ({ ...prev, [row.id]: e.target.value as "PER_LOT" | "PERCENTAGE" }))}
                      className="w-36"
                    >
                      <option value="PER_LOT">Per lot ($)</option>
                      <option value="PERCENTAGE">Percentage (%)</option>
                    </Select>
                  </TableCell>
                  <TableCell align="right">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={draftRate[row.id] ?? row.commissionRate}
                      onChange={(e) => setDraftRate((prev) => ({ ...prev, [row.id]: e.target.value }))}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right" mono>
                    {row.pendingCommission}
                  </TableCell>
                  <TableCell className="text-xs text-[var(--text-3)]">{row.lastPayoutAt ?? "never"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" disabled={savingId === row.id} onClick={() => saveEdit(row)}>
                        {savingId === row.id ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="success"
                        disabled={payingId === row.id || Number(row.pendingCommission) <= 0}
                        onClick={() => setPayTarget(row)}
                      >
                        Pay
                      </Button>
                      {savedId === row.id ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
                    </div>
                    {editErrors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{editErrors[row.id]}</div> : null}
                    {payErrors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{payErrors[row.id]}</div> : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        )}
      </Card>

      <Modal open={payTarget !== null} onClose={() => setPayTarget(null)} title="Confirm commission payout">
        {payTarget ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Pay <span className="font-mono text-[var(--text-1)]">{payTarget.pendingCommission}</span> to{" "}
              <span className="text-[var(--text-1)]">
                {payTarget.ibAccountNumber}, {payTarget.ibAccountFullName}
              </span>
              ? This moves the amount through the ledger onto the IB&apos;s own account balance and resets pending commission to zero.
            </p>
            <ModalActions>
              <Button variant="ghost" onClick={() => setPayTarget(null)}>
                Cancel
              </Button>
              <Button variant="success" disabled={payingId === payTarget.id} onClick={() => pay(payTarget)}>
                {payingId === payTarget.id ? "Paying..." : "Confirm payout"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
