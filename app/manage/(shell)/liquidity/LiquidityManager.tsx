"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type LiquidityProviderRow = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  protocol: string | null;
  status: "PROSPECTIVE" | "NEGOTIATING" | "CONTRACTED" | "CONNECTED";
  notes: string | null;
  routingRuleCount: number;
  createdAt: string;
};

export type BookExposureRow = {
  symbol: string;
  aBookVolume: string;
  bBookVolume: string;
};

const statusTone = { PROSPECTIVE: "neutral", NEGOTIATING: "warning", CONTRACTED: "accent", CONNECTED: "success" } as const;

// Self-fetches from the already-existing /api/manage/liquidity-providers
// GET (roster) and a new /api/manage/liquidity GET (book exposure,
// wrapping the same aggregate page.tsx used to compute inline) instead
// of receiving both as server-rendered props -- both the website and a
// bundled manager-shell desktop app (no Server Component of its own)
// share this one path now.
export default function LiquidityManager() {
  const [rows, setRows] = useState<LiquidityProviderRow[] | null>(null);
  const [bookExposure, setBookExposure] = useState<BookExposureRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    return Promise.all([
      fetch("/api/manage/liquidity-providers").then((r) => r.json()),
      fetch("/api/manage/liquidity").then((r) => r.json()),
    ]).then(([providers, exposure]: [LiquidityProviderRow[], BookExposureRow[]]) => {
      setRows(providers.map((p) => ({ ...p, createdAt: formatDateTime(p.createdAt) })));
      setBookExposure(exposure);
    });
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  const emptyNewLp = { name: "", contactName: "", contactEmail: "", contactPhone: "", protocol: "", notes: "" };
  const [addOpen, setAddOpen] = useState(false);
  const [newLp, setNewLp] = useState(emptyNewLp);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function openAdd() {
    setNewLp(emptyNewLp);
    setAddError(null);
    setAddOpen(true);
  }

  async function submitNewLp() {
    setAddBusy(true);
    setAddError(null);
    const response = await fetch("/api/manage/liquidity-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newLp),
    });
    setAddBusy(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setAddError(b.error ?? "failed to add");
      return;
    }
    setAddOpen(false);
    load().catch(() => {});
  }

  async function changeStatus(row: LiquidityProviderRow, status: string) {
    setBusyId(row.id);
    await fetch(`/api/manage/liquidity-providers/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    load().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Current book exposure">
        <p className="mb-3 text-sm text-[var(--text-3)]">
          Real open volume per symbol, split by the book each position was stamped into at fill time. Config-only
          routing decision (Symbols page) -- no real hedge to an LP happens for A-Book yet, since that&apos;s still
          blocked on an actual LP relationship.
        </p>
        <Table>
          <TableHead>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell align="right">A-Book volume</TableHeaderCell>
            <TableHeaderCell align="right">B-Book volume</TableHeaderCell>
          </TableHead>
          <TableBody>
            {bookExposure.length === 0 ? (
              <TableEmptyState colSpan={3}>No open positions.</TableEmptyState>
            ) : (
              bookExposure.map((row) => (
                <TableRow key={row.symbol}>
                  <TableCell mono>{row.symbol}</TableCell>
                  <TableCell align="right" mono>{row.aBookVolume}</TableCell>
                  <TableCell align="right" mono>{row.bBookVolume}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="flex justify-end">
        <Button onClick={openAdd}>Add liquidity provider</Button>
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Contact</TableHeaderCell>
          <TableHeaderCell>Protocol</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="right">Routing rules</TableHeaderCell>
          <TableHeaderCell>Added</TableHeaderCell>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmptyState colSpan={6}>No liquidity providers yet.</TableEmptyState>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  {row.name}
                  {row.notes ? <div className="text-xs font-normal text-[var(--text-3)]">{row.notes}</div> : null}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">
                  {row.contactName ?? "-"}
                  {row.contactEmail ? <div>{row.contactEmail}</div> : null}
                  {row.contactPhone ? <div>{row.contactPhone}</div> : null}
                </TableCell>
                <TableCell mono>{row.protocol ?? "-"}</TableCell>
                <TableCell>
                  <Select value={row.status} disabled={busyId === row.id} onChange={(e) => changeStatus(row, e.target.value)} className="w-36">
                    <option value="PROSPECTIVE">PROSPECTIVE</option>
                    <option value="NEGOTIATING">NEGOTIATING</option>
                    <option value="CONTRACTED">CONTRACTED</option>
                    <option value="CONNECTED">CONNECTED</option>
                  </Select>
                </TableCell>
                <TableCell align="right" mono>{row.routingRuleCount}</TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-[var(--text-3)]">
        Status badges: <Badge tone={statusTone.PROSPECTIVE}>PROSPECTIVE</Badge> <Badge tone={statusTone.NEGOTIATING}>NEGOTIATING</Badge>{" "}
        <Badge tone={statusTone.CONTRACTED}>CONTRACTED</Badge> <Badge tone={statusTone.CONNECTED}>CONNECTED</Badge>, always manually set, not detected.
      </p>

      <Card title="Latency & execution quality">
        <p className="mb-3 text-sm text-[var(--text-3)]">
          Used to be two separate pages, each just a table of &quot;Not monitored&quot; badges -- no live LP
          connection exists yet to measure any of this from (see the roster above), so there was nothing a second
          or third nav item could show that this one line doesn&apos;t already say. Folded in here; both routes come
          back with real numbers once a real LP connection exists.
        </p>
        <Table>
          <TableHead>
            <TableHeaderCell>Liquidity provider</TableHeaderCell>
            <TableHeaderCell align="right">Latency</TableHeaderCell>
            <TableHeaderCell align="right">Uptime</TableHeaderCell>
            <TableHeaderCell align="right">Slippage</TableHeaderCell>
            <TableHeaderCell align="right">Rejection rate</TableHeaderCell>
            <TableHeaderCell align="right">Fill rate</TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={6}>No liquidity providers on record yet.</TableEmptyState>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell primary>{row.name}</TableCell>
                  <TableCell align="right"><Badge tone="neutral">Not monitored</Badge></TableCell>
                  <TableCell align="right"><Badge tone="neutral">Not monitored</Badge></TableCell>
                  <TableCell align="right"><Badge tone="neutral">Not monitored</Badge></TableCell>
                  <TableCell align="right"><Badge tone="neutral">Not monitored</Badge></TableCell>
                  <TableCell align="right"><Badge tone="neutral">Not monitored</Badge></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add liquidity provider">
        <div className="flex flex-col gap-3">
          <FormField label="Name">
            <Input value={newLp.name} onChange={(e) => setNewLp((p) => ({ ...p, name: e.target.value }))} />
          </FormField>
          <FormField label="Protocol (optional)">
            <Input value={newLp.protocol} onChange={(e) => setNewLp((p) => ({ ...p, protocol: e.target.value }))} placeholder="e.g. FIX 4.4, REST API" />
          </FormField>
          <FormField label="Contact name (optional)">
            <Input value={newLp.contactName} onChange={(e) => setNewLp((p) => ({ ...p, contactName: e.target.value }))} />
          </FormField>
          <FormField label="Contact email (optional)">
            <Input type="email" value={newLp.contactEmail} onChange={(e) => setNewLp((p) => ({ ...p, contactEmail: e.target.value }))} />
          </FormField>
          <FormField label="Contact phone (optional)">
            <Input value={newLp.contactPhone} onChange={(e) => setNewLp((p) => ({ ...p, contactPhone: e.target.value }))} />
          </FormField>
          <FormField label="Notes (optional)">
            <Input value={newLp.notes} onChange={(e) => setNewLp((p) => ({ ...p, notes: e.target.value }))} />
          </FormField>
          {addError ? <p className="text-sm text-[var(--sell)]">{addError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={addBusy} onClick={submitNewLp}>
              {addBusy ? "Adding..." : "Add"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}
