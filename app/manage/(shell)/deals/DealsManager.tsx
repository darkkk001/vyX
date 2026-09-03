"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { TableSkeleton, TableErrorState, useTableSort, SortableHeaderCell } from "@/components/ui/TableExtras";
import DealingReplayPanel from "@/components/admin/DealingReplayPanel";

export type DealRow = {
  id: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  status: "CLOSED" | "VOIDED";
  volume: string;
  openPrice: string;
  closePrice: string;
  commission: string;
  swap: string;
  realizedPnl: string;
  closedAt: string;
};

// Self-fetches from /api/manage/deals instead of receiving rows as a
// server-rendered prop -- both the website and a bundled manager-shell
// desktop app (no Server Component of its own) share this one path now.
function getDealSortValue(row: DealRow, key: string): string | number | null {
  switch (key) {
    case "account":
      return row.accountNumber;
    case "symbol":
      return row.symbol;
    case "side":
      return row.side;
    case "volume":
      return Number(row.volume);
    case "openPrice":
      return Number(row.openPrice);
    case "closePrice":
      return Number(row.closePrice);
    case "commission":
      return Number(row.commission);
    case "swap":
      return Number(row.swap);
    case "realizedPnl":
      return row.realizedPnl === "—" ? null : Number(row.realizedPnl);
    case "closedAt":
      return row.closedAt;
    default:
      return null;
  }
}

export default function DealsManager() {
  const [rows, setRows] = useState<DealRow[] | null>(null);
  // Same Empty-vs-Error-vs-Loading fix as PositionsManager -- a failed
  // fetch used to render identically to "zero closed deals" via
  // `.catch(() => setRows([]))`.
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const [replayPositionId, setReplayPositionId] = useState<string | null>(null);

  function reload() {
    return fetch("/api/manage/deals")
      .then((r) => {
        if (!r.ok) throw new Error(`deals fetch failed: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setRows(d);
        setLoadError(false);
      });
  }
  useEffect(() => {
    reload().catch(() => setLoadError(true));
  }, []);

  // VYX-POSITION-TOOLS-V0 -- true DELETE (see Position.deletedAt's own
  // schema comment). Only ever eligible here, never on Live Exposure's
  // OPEN rows -- see lib/position-actions.ts's executeDelete.
  const [deleteConfirm, setDeleteConfirm] = useState<DealRow | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [pendingToast, setPendingToast] = useState<string | null>(null);

  async function deleteDeal(row: DealRow) {
    setDeletingId(row.id);
    setDeleteError("");
    const response = await fetch(`/api/manage/positions/${row.id}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: deleteReason }),
    });
    setDeletingId(null);
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) {
      setDeleteConfirm(null);
      setDeleteReason("");
      setPendingToast("Delete submitted for approval -- a different admin needs to review it (Live Exposure page).");
      return;
    }
    if (!response.ok) {
      setDeleteError(body.error ?? "delete failed");
      return;
    }
    setDeleteConfirm(null);
    setDeleteReason("");
    reload().catch(() => {});
  }

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (r) => !q || r.accountNumber.toLowerCase().includes(q) || r.accountFullName.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q)
  );
  const { sortedRows: sortedDeals, sortKey, direction, onSort } = useTableSort(filtered, getDealSortValue);

  if (rows === null && !loadError) {
    return (
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell>Side</TableHeaderCell>
          <TableHeaderCell align="right">Volume</TableHeaderCell>
          <TableHeaderCell align="right">Open</TableHeaderCell>
          <TableHeaderCell align="right">Close</TableHeaderCell>
          <TableHeaderCell align="right">Commission</TableHeaderCell>
          <TableHeaderCell align="right">Swap</TableHeaderCell>
          <TableHeaderCell align="right">P&L</TableHeaderCell>
          <TableHeaderCell>Closed</TableHeaderCell>
          <TableHeaderCell></TableHeaderCell>
        </TableHead>
        <TableBody>
          <TableSkeleton columns={11} />
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-3)]">
        {(rows ?? []).length} closed trade{(rows ?? []).length === 1 ? "" : "s"} (most recent 500) across this broker.
      </p>
      <Input
        type="text"
        placeholder="Search by account number, name, or symbol..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <Table>
        <thead className="sticky top-0 z-10 bg-[var(--bg-2)]">
          <tr>
            {[
              { key: "account", label: "Account", align: "left" as const },
              { key: "symbol", label: "Symbol", align: "left" as const },
              { key: "side", label: "Side", align: "left" as const },
              { key: "volume", label: "Volume", align: "right" as const },
              { key: "openPrice", label: "Open", align: "right" as const },
              { key: "closePrice", label: "Close", align: "right" as const },
              { key: "commission", label: "Commission", align: "right" as const },
              { key: "swap", label: "Swap", align: "right" as const },
              { key: "realizedPnl", label: "P&L", align: "right" as const },
              { key: "closedAt", label: "Closed", align: "left" as const },
            ].map((c) => (
              <SortableHeaderCell key={c.key} sortKey={c.key} activeSortKey={sortKey} direction={direction} onSort={onSort} align={c.align}>
                {c.label}
              </SortableHeaderCell>
            ))}
            <TableHeaderCell></TableHeaderCell>
          </tr>
        </thead>
        <TableBody>
          {loadError ? (
            <TableErrorState colSpan={11} onRetry={() => reload().catch(() => setLoadError(true))} />
          ) : sortedDeals.length === 0 ? (
            <TableEmptyState colSpan={11}>No closed deals match.</TableEmptyState>
          ) : (
            sortedDeals.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.accountFullName}</div>
                </TableCell>
                <TableCell mono>{row.symbol}</TableCell>
                <TableCell>
                  <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge>
                  {row.status === "VOIDED" ? (
                    <span className="ml-1.5">
                      <Badge tone="warning">VOIDED</Badge>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell align="right" mono>{row.volume}</TableCell>
                <TableCell align="right" mono>{row.openPrice}</TableCell>
                <TableCell align="right" mono>{row.closePrice}</TableCell>
                <TableCell align="right" mono>{row.commission}</TableCell>
                <TableCell align="right" mono>{row.swap}</TableCell>
                <TableCell align="right" mono className={row.realizedPnl !== "—" && Number(row.realizedPnl) < 0 ? "text-[var(--sell)]" : "text-[var(--buy)]"}>
                  {row.realizedPnl}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.closedAt}</TableCell>
                <TableCell align="right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" onClick={() => setReplayPositionId(row.id)}>Replay</Button>
                    <Button variant="ghost" onClick={() => { setDeleteReason(""); setDeleteError(""); setDeleteConfirm(row); }} title="Remove from the trader's statement/history -- admin-only, recoverable from the audit view">
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {replayPositionId ? (
        <DealingReplayPanel positionId={replayPositionId} onClose={() => setReplayPositionId(null)} />
      ) : null}

      {pendingToast ? <p className="text-xs text-[var(--accent)]">{pendingToast}</p> : null}

      <Modal open={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title="Confirm delete deal">
        {deleteConfirm ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Removes {deleteConfirm.accountNumber}&apos;s {deleteConfirm.symbol} {deleteConfirm.side} deal from the trader-visible
              statement/history entirely. The row itself isn&apos;t erased -- it&apos;s recoverable from the audit log. A reason is required.
            </p>
            <FormField label="Reason (required)">
              <Input value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} placeholder="Why this row is being removed from the trader's history" />
            </FormField>
            {deleteError ? <div className="text-xs text-[var(--sell)]">{deleteError}</div> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={deletingId === deleteConfirm.id || deleteReason.trim() === ""} onClick={() => deleteDeal(deleteConfirm)}>
                {deletingId === deleteConfirm.id ? "Deleting..." : "Confirm delete"}
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
