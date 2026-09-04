"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { useAdminEventStream, ADMIN_STREAM_RECONNECTED, type AdminEvent } from "@/lib/admin-realtime";
import { formatDateTime } from "@/lib/format";
import type { DealerActivityAction } from "@/lib/dealer-activity";

type Account = { id: string; accountNumber: string; fullName: string };

type RestingOrder = {
  orderId: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: string;
  orderType: "LIMIT" | "STOP";
  requestedPrice: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  createdAt: string;
};

type FeedRow = {
  id: string;
  at: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  action: DealerActivityAction;
  symbol?: string;
  side?: string;
  volume?: string;
  values: Record<string, unknown>;
};

const MAX_FEED_ROWS = 50;
const ALL_ACCOUNTS = "__all__";

const ACTION_LABEL: Record<DealerActivityAction, string> = {
  ORDER_PLACED: "Order placed",
  ORDER_MODIFIED: "SL/TP modified",
  ORDER_CANCELLED: "Order cancelled",
  ORDER_TRIGGERED: "Pending order triggered",
  POSITION_OPENED: "Position opened",
  POSITION_CLOSED: "Position closed",
};

const ACTION_TONE: Record<DealerActivityAction, "accent" | "warning" | "danger" | "success" | "neutral"> = {
  ORDER_PLACED: "accent",
  ORDER_MODIFIED: "warning",
  ORDER_CANCELLED: "danger",
  ORDER_TRIGGERED: "warning",
  POSITION_OPENED: "success",
  POSITION_CLOSED: "neutral",
};

function fmt(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

function describeValues(row: FeedRow): string {
  const v = row.values;
  switch (row.action) {
    case "ORDER_PLACED": {
      const parts: string[] = [];
      const trigger = fmt(v.triggerPrice) ?? fmt(v.requestedPrice);
      if (trigger) parts.push(`@ ${trigger}`);
      if (fmt(v.slPrice)) parts.push(`SL ${v.slPrice}`);
      if (fmt(v.tpPrice)) parts.push(`TP ${v.tpPrice}`);
      return parts.join(" ");
    }
    case "ORDER_MODIFIED": {
      const parts: string[] = [];
      if (fmt(v.oldSlPrice) !== fmt(v.newSlPrice) && (fmt(v.oldSlPrice) || fmt(v.newSlPrice))) {
        parts.push(`SL ${fmt(v.oldSlPrice) ?? "—"} → ${fmt(v.newSlPrice) ?? "—"}`);
      }
      if (fmt(v.oldTpPrice) !== fmt(v.newTpPrice) && (fmt(v.oldTpPrice) || fmt(v.newTpPrice))) {
        parts.push(`TP ${fmt(v.oldTpPrice) ?? "—"} → ${fmt(v.newTpPrice) ?? "—"}`);
      }
      if (fmt(v.oldRequestedPrice) !== fmt(v.newRequestedPrice) && (fmt(v.oldRequestedPrice) || fmt(v.newRequestedPrice))) {
        parts.push(`Entry ${fmt(v.oldRequestedPrice) ?? "—"} → ${fmt(v.newRequestedPrice) ?? "—"}`);
      }
      return parts.join(", ");
    }
    case "ORDER_CANCELLED":
      return fmt(v.requestedPrice) ? `@ ${v.requestedPrice}` : "";
    case "ORDER_TRIGGERED":
      return `triggered @ ${fmt(v.triggerPrice) ?? "—"} — now in approval queue`;
    case "POSITION_OPENED":
      return `@ ${fmt(v.openPrice) ?? fmt(v.filledPrice) ?? "—"}`;
    case "POSITION_CLOSED": {
      const parts = [`@ ${fmt(v.closePrice) ?? "—"}`];
      if (v.partial) parts.push("(partial)");
      if (fmt(v.realizedPnl)) parts.push(`P&L ${v.realizedPnl}`);
      return parts.join(" ");
    }
    default:
      return "";
  }
}

// Dealing page's own dedicated panel (2026-09-04 refinement, tightened
// same day: a separate general every-account feed briefly lived on Live
// Exposure too, removed as redundant clutter -- this is now the ONLY
// place a dealer-activity feed is mounted). Scoped to DEALING-group
// accounts ONLY: a persistent "resting orders" list (currently-active
// LIMIT/STOP orders -- not just feed events that scroll away) plus an
// activity feed, both filterable to one account. The point: a dealer
// watching this page sees the complete picture of every manually-managed
// account, live, no refresh -- see GET /api/manage/dealing-desk and
// lib/dealer-activity.ts. Live Exposure stays focused on exposure/P&L.
export default function DealingDeskPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [restingOrders, setRestingOrders] = useState<RestingOrder[] | null>(null);
  const [feedRows, setFeedRows] = useState<FeedRow[] | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const feedScrollRef = useRef<HTMLDivElement>(null);

  function load() {
    return fetch("/api/manage/dealing-desk")
      .then((r) => r.json())
      .then((d: { accounts: Account[]; restingOrders: RestingOrder[]; feedRows: FeedRow[] }) => {
        setAccounts(d.accounts);
        setRestingOrders(d.restingOrders);
        setFeedRows(d.feedRows);
      });
  }

  useEffect(() => {
    load().catch(() => {
      setAccounts([]);
      setRestingOrders([]);
      setFeedRows([]);
    });
  }, []);

  useAdminEventStream((event: AdminEvent) => {
    if (event.type === ADMIN_STREAM_RECONNECTED) {
      load().catch(() => {});
      return;
    }
    if (event.type !== "DealerActivity" || !event.is_dealing_group) return;

    const action = event.action as DealerActivityAction;
    const orderId = event.order_id ? String(event.order_id) : null;
    const values = (event.values as Record<string, unknown>) ?? {};

    const row: FeedRow = {
      id: `${event.order_id ?? event.position_id ?? "evt"}-${event.at}`,
      at: String(event.at),
      accountId: String(event.account_id),
      accountNumber: String(event.account_number),
      accountFullName: String(event.account_full_name ?? ""),
      action,
      symbol: event.symbol ? String(event.symbol) : undefined,
      side: event.side ? String(event.side) : undefined,
      volume: event.volume ? String(event.volume) : undefined,
      values,
    };
    setFeedRows((prev) => [row, ...(prev ?? [])].slice(0, MAX_FEED_ROWS));
    requestAnimationFrame(() => {
      if (feedScrollRef.current && feedScrollRef.current.scrollTop < 40) {
        feedScrollRef.current.scrollTop = 0;
      }
    });

    if (!orderId) return; // position-level events don't touch the resting-orders list

    if (action === "ORDER_PLACED" && (values.orderType === "LIMIT" || values.orderType === "STOP")) {
      const resting: RestingOrder = {
        orderId,
        accountId: row.accountId,
        accountNumber: row.accountNumber,
        accountFullName: row.accountFullName,
        symbol: row.symbol ?? "",
        digits: 5,
        side: (row.side as "BUY" | "SELL") ?? "BUY",
        volume: row.volume ?? "",
        orderType: values.orderType,
        requestedPrice: fmt(values.requestedPrice),
        slPrice: fmt(values.slPrice),
        tpPrice: fmt(values.tpPrice),
        createdAt: row.at,
      };
      setRestingOrders((prev) => [resting, ...(prev ?? []).filter((r) => r.orderId !== orderId)]);
      return;
    }
    if (action === "ORDER_MODIFIED") {
      setRestingOrders((prev) =>
        (prev ?? []).map((r) =>
          r.orderId === orderId
            ? {
                ...r,
                slPrice: values.newSlPrice !== undefined ? fmt(values.newSlPrice) : r.slPrice,
                tpPrice: values.newTpPrice !== undefined ? fmt(values.newTpPrice) : r.tpPrice,
                requestedPrice: values.newRequestedPrice !== undefined ? fmt(values.newRequestedPrice) : r.requestedPrice,
              }
            : r
        )
      );
      return;
    }
    if (action === "ORDER_CANCELLED" || action === "ORDER_TRIGGERED") {
      // TRIGGERED reclassifies the order to MARKET/PENDING (now in the
      // approval queue, see DealingQueueManager.tsx) -- it's no longer a
      // resting LIMIT/STOP order either way, same removal as a cancel.
      setRestingOrders((prev) => (prev ?? []).filter((r) => r.orderId !== orderId));
    }
  });

  const accountLabel = (a: Account) => `${a.accountNumber} — ${a.fullName}`;
  const filteredResting = restingOrders?.filter((r) => accountFilter === ALL_ACCOUNTS || r.accountId === accountFilter) ?? null;
  const filteredFeed = feedRows?.filter((r) => accountFilter === ALL_ACCOUNTS || r.accountId === accountFilter) ?? null;

  if (accounts === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-3)]">
          Every action on a DEALING-group account, live -- resting pending orders plus the full activity feed. Nothing here is polled.
        </p>
        <div className="w-64">
          <Select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value={ALL_ACCOUNTS}>All dealing-group accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-1)]">Resting orders</h3>
          <span className="text-xs text-[var(--text-3)]">
            {filteredResting?.length ?? 0} active LIMIT/STOP order{(filteredResting?.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        <Table>
          <TableHead>
            <TableHeaderCell>Account</TableHeaderCell>
            <TableHeaderCell>Symbol</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Side</TableHeaderCell>
            <TableHeaderCell align="right">Volume</TableHeaderCell>
            <TableHeaderCell align="right">Price</TableHeaderCell>
            <TableHeaderCell align="right">S/L</TableHeaderCell>
            <TableHeaderCell align="right">T/P</TableHeaderCell>
            <TableHeaderCell>Placed</TableHeaderCell>
          </TableHead>
          <TableBody>
            {filteredResting === null ? (
              <TableEmptyState colSpan={9}>Loading...</TableEmptyState>
            ) : filteredResting.length === 0 ? (
              <TableEmptyState colSpan={9}>No resting orders on dealing-group accounts right now.</TableEmptyState>
            ) : (
              filteredResting.map((r) => (
                <TableRow key={r.orderId}>
                  <TableCell primary>
                    <Link href={`/manage/accounts/${r.accountId}`} className="hover:underline">
                      <span className="font-mono">{r.accountNumber}</span>
                      <div className="text-xs font-normal text-[var(--text-3)]">{r.accountFullName}</div>
                    </Link>
                  </TableCell>
                  <TableCell mono>{r.symbol}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">{r.orderType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={r.side === "BUY" ? "success" : "danger"}>{r.side}</Badge>
                  </TableCell>
                  <TableCell align="right" mono>{r.volume}</TableCell>
                  <TableCell align="right" mono>{r.requestedPrice ?? "—"}</TableCell>
                  <TableCell align="right" mono>{r.slPrice ?? "—"}</TableCell>
                  <TableCell align="right" mono>{r.tpPrice ?? "—"}</TableCell>
                  <TableCell className="text-xs text-[var(--text-3)]">{formatDateTime(r.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-1)]">Dealing-group activity feed</h3>
          <span className="text-xs text-[var(--text-3)]">Live · last {MAX_FEED_ROWS}</span>
        </div>
        <div ref={feedScrollRef} className="flex max-h-[520px] flex-col gap-1 overflow-y-auto">
          {filteredFeed === null ? (
            <p className="py-6 text-center text-sm text-[var(--text-3)]">Loading...</p>
          ) : filteredFeed.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-3)]">No activity yet.</p>
          ) : (
            filteredFeed.map((row) => (
              <Link
                key={row.id}
                href={`/manage/accounts/${row.accountId}`}
                className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm transition-colors hover:brightness-105"
              >
                <span className="w-[110px] shrink-0 text-xs text-[var(--text-3)]">{formatDateTime(row.at)}</span>
                <span className="w-[110px] shrink-0 font-mono text-xs">{row.accountNumber}</span>
                <Badge tone={ACTION_TONE[row.action]}>{ACTION_LABEL[row.action]}</Badge>
                <span className="w-[70px] shrink-0 font-mono text-xs">{row.symbol ?? "—"}</span>
                {row.side ? <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge> : null}
                <span className="shrink-0 font-mono text-xs">{row.volume ?? ""}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-2)]">{describeValues(row)}</span>
              </Link>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
