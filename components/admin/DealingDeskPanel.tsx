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
import { ActivityFeedRows, type ActivityFeedRow } from "./ActivityFeedRows";

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

type FeedRow = ActivityFeedRow;

const MAX_FEED_ROWS = 50;
const ALL_ACCOUNTS = "__all__";

function fmt(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
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
      isDealingGroup: true, // filtered to event.is_dealing_group above -- always true here
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
        <div ref={feedScrollRef} className="max-h-[520px] overflow-y-auto">
          {filteredFeed === null ? (
            <p className="py-6 text-center text-sm text-[var(--text-3)]">Loading...</p>
          ) : filteredFeed.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-3)]">No activity yet.</p>
          ) : (
            // showDealingChip omitted -- every row here is already
            // DEALING-group by definition (this panel's own scope), so the
            // chip would just repeat itself on every single row.
            <ActivityFeedRows rows={filteredFeed} />
          )}
        </div>
      </Card>
    </div>
  );
}
