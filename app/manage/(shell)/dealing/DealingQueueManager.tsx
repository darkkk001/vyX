"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { useAdminEventStream, ADMIN_STREAM_RECONNECTED, type AdminEvent } from "@/lib/admin-realtime";

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

export type RequotedOrderRow = {
  id: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  requestedPrice: string | null;
  requotedPrice: string | null;
  createdAt: string;
};

// Self-fetches from /api/manage/dealing-queue (extended to also return
// requotedRows and flat liveBid/liveAsk, matching page.tsx's previous
// query exactly -- confirmed unused by anything else before this)
// instead of receiving both as server-rendered props -- both the
// website and a bundled manager-shell desktop app (no Server Component
// of its own) share this one path now.
export default function DealingQueueManager() {
  const [rows, setRows] = useState<DealingOrderRow[] | null>(null);
  const [requotedRows, setRequotedRows] = useState<RequotedOrderRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    return fetch("/api/manage/dealing-queue")
      .then((r) => r.json())
      .then((d: { rows: DealingOrderRow[]; requotedRows: RequotedOrderRow[] }) => {
        setRows(d.rows.map((r) => ({ ...r, createdAt: r.createdAt.replace("T", " ").slice(0, 19) })));
        setRequotedRows(d.requotedRows.map((r) => ({ ...r, createdAt: r.createdAt.replace("T", " ").slice(0, 19) })));
      });
  }

  // Initial paint only -- live updates come from the event stream below
  // (fix/realtime-sync §1), not a poll. This used to be a 5s
  // setInterval; a new order landing in the queue, or a client responding
  // to a requote, could take up to 5s to appear and doubled as this
  // page's only way to notice a stale/dropped connection.
  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  // DealingQueued is applied straight to `rows` (no refetch) so a new
  // order appears well under the 200ms this fix's acceptance test
  // requires -- see app/api/trade/orders/route.ts's publish call for
  // exactly which fields this depends on. OrderFilled/OrderRejected
  // remove a row wherever it currently lives (rows or requotedRows,
  // covering both a fresh accept/reject and a requote's resolution).
  // OrderRequoted moves a row from rows to requotedRows in place.
  // OrderCancelled only ever matters here as a requote the client
  // withdrew/declined -- a no-op if the id isn't in requotedRows (e.g. an
  // unrelated resting LIMIT/STOP order the trader cancelled directly).
  useAdminEventStream((event: AdminEvent) => {
    if (event.type === ADMIN_STREAM_RECONNECTED) {
      load().catch(() => {});
      return;
    }

    if (event.type === "DealingQueued") {
      const row: DealingOrderRow = {
        id: String(event.order_id),
        accountNumber: String(event.account_number),
        accountFullName: String(event.account_full_name),
        symbol: String(event.symbol),
        digits: Number(event.digits),
        side: event.side as "BUY" | "SELL",
        volume: String(event.volume),
        requestedPrice: event.requested_price == null ? null : String(event.requested_price),
        createdAt: String(event.created_at).replace("T", " ").slice(0, 19),
        liveBid: event.live_bid == null ? null : String(event.live_bid),
        liveAsk: event.live_ask == null ? null : String(event.live_ask),
      };
      setRows((prev) => (prev ? [row, ...prev] : [row]));
      return;
    }

    if (event.type === "OrderFilled" || event.type === "OrderRejected") {
      const orderId = String(event.order_id);
      setRows((prev) => prev?.filter((r) => r.id !== orderId) ?? prev);
      setRequotedRows((prev) => prev.filter((r) => r.id !== orderId));
      return;
    }

    if (event.type === "OrderRequoted") {
      const orderId = String(event.order_id);
      setRows((prev) => {
        if (!prev) return prev;
        const found = prev.find((r) => r.id === orderId);
        if (!found) return prev;
        const requoted: RequotedOrderRow = {
          id: found.id,
          accountNumber: found.accountNumber,
          accountFullName: found.accountFullName,
          symbol: found.symbol,
          digits: found.digits,
          side: found.side,
          volume: found.volume,
          requestedPrice: found.requestedPrice,
          requotedPrice: event.requoted_price == null ? null : String(event.requoted_price),
          createdAt: found.createdAt,
        };
        setRequotedRows((prevRequoted) => [requoted, ...prevRequoted]);
        return prev.filter((r) => r.id !== orderId);
      });
      return;
    }

    if (event.type === "OrderCancelled") {
      const orderId = String(event.order_id);
      setRequotedRows((prev) => prev.filter((r) => r.id !== orderId));
    }
  });

  const [acceptTarget, setAcceptTarget] = useState<DealingOrderRow | null>(null);
  const [acceptPrice, setAcceptPrice] = useState("");
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [rejectTarget, setRejectTarget] = useState<DealingOrderRow | RequotedOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  function openAccept(row: DealingOrderRow) {
    const live = row.side === "BUY" ? row.liveAsk : row.liveBid;
    setAcceptTarget(row);
    setAcceptPrice(live ?? row.requestedPrice ?? "");
    setAcceptError(null);
  }

  function openReject(row: DealingOrderRow | RequotedOrderRow) {
    setRejectTarget(row);
    setRejectReason("");
    setRejectError(null);
  }

  // Optimistic: the row disappears the instant this dealer clicks
  // Accept/Reject rather than waiting for the PATCH to resolve (fix/
  // realtime-sync §8's "every action is optimistic + reconciled by its
  // ack event" rule) -- the eventual OrderFilled/OrderRejected/
  // OrderRequoted event (this same action, echoed back over the event
  // stream) then finds nothing left to remove, a harmless no-op. On
  // failure, the row is spliced back to where it was.
  async function submitAccept() {
    if (!acceptTarget) return;
    const price = Number(acceptPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setAcceptError("Enter a valid price");
      return;
    }
    const target = acceptTarget;
    setBusyId(target.id);
    setAcceptError(null);
    setRows((prev) => prev?.filter((r) => r.id !== target.id) ?? prev);
    setAcceptTarget(null);

    const response = await fetch(`/api/manage/dealing-queue/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ACCEPT", price }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setRows((prev) => (prev ? [target, ...prev] : [target]));
      setAcceptTarget(target);
      setAcceptError(b.error ?? "accept failed");
    }
  }

  async function submitReject() {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      setRejectError("Reason is required");
      return;
    }
    const target = rejectTarget;
    const wasRequote = "requotedPrice" in target;
    setBusyId(target.id);
    setRejectError(null);
    if (wasRequote) {
      setRequotedRows((prev) => prev.filter((r) => r.id !== target.id));
    } else {
      setRows((prev) => prev?.filter((r) => r.id !== target.id) ?? prev);
    }
    setRejectTarget(null);

    const response = await fetch(`/api/manage/dealing-queue/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "REJECT", reason: rejectReason.trim() }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      if (wasRequote) {
        setRequotedRows((prev) => [target as RequotedOrderRow, ...prev]);
      } else {
        setRows((prev) => (prev ? [target as DealingOrderRow, ...prev] : [target as DealingOrderRow]));
      }
      setRejectTarget(target);
      setRejectError(b.error ?? "reject failed");
    }
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-3)]">
        {rows.length} order{rows.length === 1 ? "" : "s"} awaiting manual review, {requotedRows.length} awaiting the client&apos;s answer to a requote. Only populated while dealing mode is on (Risk page).
      </p>
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
          {rows.length === 0 ? (
            <TableEmptyState colSpan={8}>No orders awaiting review.</TableEmptyState>
          ) : (
            rows.map((row) => (
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

      <div>
        <h3 className="mb-2 text-sm font-medium text-[var(--text-2)]">Awaiting client confirmation</h3>
        <Table>
          <TableHead>
            <TableHeaderCell>Account</TableHeaderCell>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell>Side</TableHeaderCell>
            <TableHeaderCell align="right">Volume</TableHeaderCell>
            <TableHeaderCell align="right">Requested</TableHeaderCell>
            <TableHeaderCell align="right">Requoted to</TableHeaderCell>
            <TableHeaderCell>Requoted at</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            {requotedRows.length === 0 ? (
              <TableEmptyState colSpan={8}>No requotes awaiting a client response.</TableEmptyState>
            ) : (
              requotedRows.map((row) => (
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
                  <TableCell align="right" mono>{row.requotedPrice ?? "—"}</TableCell>
                  <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button size="sm" variant="danger" disabled={busyId === row.id} onClick={() => openReject(row)}>
                      Withdraw
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Modal open={acceptTarget !== null} onClose={() => setAcceptTarget(null)} title={`Accept order — ${acceptTarget?.accountNumber ?? ""}`}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-2)]">
            {acceptTarget
              ? `${acceptTarget.side} ${acceptTarget.volume} lots of ${acceptTarget.symbol}. Pre-filled with the current live price — accepting at that price fills instantly. Changing it sends a requote to the client, who must accept before it fills.`
              : ""}
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

      <Modal
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title={`${rejectTarget && "requotedPrice" in rejectTarget ? "Withdraw requote" : "Reject order"} — ${rejectTarget?.accountNumber ?? ""}`}
      >
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
              {busyId === rejectTarget?.id ? "Working..." : rejectTarget && "requotedPrice" in rejectTarget ? "Withdraw requote" : "Reject order"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}
