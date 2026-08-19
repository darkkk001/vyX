"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type DealingOrderRow = {
  id: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  requestedPrice: string | null;
  createdAt: string;
  liveBid: string | null;
  liveAsk: string | null;
};

export default function DealingQueueManager({ initialRows }: { initialRows: DealingOrderRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const [acceptTarget, setAcceptTarget] = useState<DealingOrderRow | null>(null);
  const [acceptPrice, setAcceptPrice] = useState("");
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [rejectTarget, setRejectTarget] = useState<DealingOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  function openAccept(row: DealingOrderRow) {
    const live = row.side === "BUY" ? row.liveAsk : row.liveBid;
    setAcceptTarget(row);
    setAcceptPrice(live ?? row.requestedPrice ?? "");
    setAcceptError(null);
  }

  function openReject(row: DealingOrderRow) {
    setRejectTarget(row);
    setRejectReason("");
    setRejectError(null);
  }

  async function submitAccept() {
    if (!acceptTarget) return;
    const price = Number(acceptPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setAcceptError("Enter a valid price");
      return;
    }
    setBusyId(acceptTarget.id);
    setAcceptError(null);
    const response = await fetch(`/api/manage/dealing-queue/${acceptTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ACCEPT", price }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setAcceptError(b.error ?? "accept failed");
      return;
    }
    setAcceptTarget(null);
    router.refresh();
  }

  async function submitReject() {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      setRejectError("Reason is required");
      return;
    }
    setBusyId(rejectTarget.id);
    setRejectError(null);
    const response = await fetch(`/api/manage/dealing-queue/${rejectTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "REJECT", reason: rejectReason.trim() }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setRejectError(b.error ?? "reject failed");
      return;
    }
    setRejectTarget(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Symbol</TableHeaderCell>
          <TableHeaderCell>Side</TableHeaderCell>
          <TableHeaderCell align="right">Volume</TableHeaderCell>
          <TableHeaderCell align="right">Requested</TableHeaderCell>
          <TableHeaderCell align="right">Live</TableHeaderCell>
          <TableHeaderCell>Submitted</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {initialRows.length === 0 ? (
            <TableEmptyState colSpan={8}>No orders awaiting review.</TableEmptyState>
          ) : (
            initialRows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.accountFullName}</div>
                </TableCell>
                <TableCell mono>{row.symbol}</TableCell>
                <TableCell>
                  <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge>
                </TableCell>
                <TableCell align="right" mono>{row.volume}</TableCell>
                <TableCell align="right" mono>{row.requestedPrice ?? "—"}</TableCell>
                <TableCell align="right" mono>
                  {row.liveBid && row.liveAsk ? `${row.liveBid} / ${row.liveAsk}` : "no feed"}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="success" disabled={busyId === row.id} onClick={() => openAccept(row)}>
                      Accept
                    </Button>
                    <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => openReject(row)}>
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={acceptTarget !== null} onClose={() => setAcceptTarget(null)} title={`Accept order — ${acceptTarget?.accountNumber ?? ""}`}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            {acceptTarget ? `${acceptTarget.side} ${acceptTarget.volume} lots of ${acceptTarget.symbol}. Pre-filled with the current live price — change it to requote.` : ""}
          </p>
          <FormField label="Fill price">
            <Input type="text" inputMode="decimal" mono value={acceptPrice} onChange={(e) => setAcceptPrice(e.target.value)} />
          </FormField>
          {acceptError ? <p className="text-sm text-[var(--sell)]">{acceptError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setAcceptTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busyId === acceptTarget?.id} onClick={submitAccept}>
              {busyId === acceptTarget?.id ? "Filling..." : "Accept & fill"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={`Reject order — ${rejectTarget?.accountNumber ?? ""}`}>
        <div className="flex flex-col gap-3">
          <FormField label="Reason (required, logged in audit trail)">
            <Input type="text" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Price moved outside tolerance" />
          </FormField>
          {rejectError ? <p className="text-sm text-[var(--sell)]">{rejectError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busyId === rejectTarget?.id} onClick={submitReject}>
              {busyId === rejectTarget?.id ? "Rejecting..." : "Reject order"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}
