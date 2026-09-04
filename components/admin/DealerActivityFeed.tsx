"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { useAdminEventStream, ADMIN_STREAM_RECONNECTED, type AdminEvent } from "@/lib/admin-realtime";
import { formatDateTime } from "@/lib/format";

export type DealerActivityAction = "ORDER_PLACED" | "ORDER_MODIFIED" | "ORDER_CANCELLED" | "ORDER_TRIGGERED" | "POSITION_OPENED" | "POSITION_CLOSED";

type FeedRow = {
  id: string;
  at: string;
  accountId: string;
  accountNumber: string;
  accountFullName: string;
  isDealingGroup: boolean;
  action: DealerActivityAction;
  symbol?: string;
  side?: string;
  volume?: string;
  values: Record<string, unknown>;
};

const MAX_ROWS = 50;

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

// One human line of "what actually happened" per action, from whatever
// subset of `values` that action's own call site populated (see
// lib/dealer-activity.ts's call sites -- every action publishes a
// different shape, this is the one place that has to know all of them).
function describeValues(row: FeedRow): string {
  const v = row.values;
  switch (row.action) {
    case "ORDER_PLACED": {
      const parts: string[] = [];
      const trigger = fmt(v.triggerPrice) ?? fmt(v.requestedPrice);
      if (trigger) parts.push(`@ ${trigger}`);
      if (fmt(v.slPrice)) parts.push(`SL ${v.slPrice}`);
      if (fmt(v.tpPrice)) parts.push(`TP ${v.tpPrice}`);
      if (v.queuedForDealing) parts.push("(queued for dealing)");
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
      return `triggered @ ${fmt(v.triggerPrice) ?? "—"}`;
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

// Live activity feed for the dealer -- every order-lifecycle event across
// this broker's accounts (see lib/dealer-activity.ts's DealerActivity
// event), rendered newest-first with a rolling MAX_ROWS cap. Cold-loads
// its last ~50 rows from AuditLog (GET /api/manage/dealer-activity, see
// that route's own doc comment on its two disclosed backfill gaps), then
// stays live purely off the event stream -- no polling.
export default function DealerActivityFeed() {
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function load() {
    return fetch("/api/manage/dealer-activity")
      .then((r) => r.json())
      .then((d: { rows: FeedRow[] }) => setRows(d.rows));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  useAdminEventStream((event: AdminEvent) => {
    if (event.type === ADMIN_STREAM_RECONNECTED) {
      load().catch(() => {});
      return;
    }
    if (event.type !== "DealerActivity") return;

    const row: FeedRow = {
      id: `${event.order_id ?? event.position_id ?? "evt"}-${event.at}`,
      at: String(event.at),
      accountId: String(event.account_id),
      accountNumber: String(event.account_number),
      accountFullName: String(event.account_full_name ?? ""),
      isDealingGroup: !!event.is_dealing_group,
      action: event.action as DealerActivityAction,
      symbol: event.symbol ? String(event.symbol) : undefined,
      side: event.side ? String(event.side) : undefined,
      volume: event.volume ? String(event.volume) : undefined,
      values: (event.values as Record<string, unknown>) ?? {},
    };
    setRows((prev) => [row, ...(prev ?? [])].slice(0, MAX_ROWS));
    // Auto-scroll to the newest row (top of the list) unless the dealer
    // has deliberately scrolled down to read older history -- a small
    // threshold near the top counts as "still following the live feed".
    requestAnimationFrame(() => {
      if (scrollRef.current && scrollRef.current.scrollTop < 40) {
        scrollRef.current.scrollTop = 0;
      }
    });
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-1)]">Dealer activity feed</h3>
        <span className="text-xs text-[var(--text-3)]">Live · last {MAX_ROWS}</span>
      </div>
      <div ref={scrollRef} className="flex max-h-[520px] flex-col gap-1 overflow-y-auto">
        {rows === null ? (
          <p className="py-6 text-center text-sm text-[var(--text-3)]">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--text-3)]">No activity yet.</p>
        ) : (
          rows.map((row) => (
            <Link
              key={row.id}
              href={`/manage/accounts/${row.accountId}`}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:brightness-105 ${
                row.isDealingGroup
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-[var(--border)] bg-[var(--bg-1)]"
              }`}
            >
              <span className="w-[110px] shrink-0 text-xs text-[var(--text-3)]">{formatDateTime(row.at)}</span>
              <span className="w-[110px] shrink-0 font-mono text-xs">
                {row.accountNumber}
                {row.isDealingGroup ? <Badge tone="warning">DEALING</Badge> : null}
              </span>
              <Badge tone={ACTION_TONE[row.action]}>{ACTION_LABEL[row.action]}</Badge>
              <span className="w-[70px] shrink-0 font-mono text-xs">{row.symbol ?? "—"}</span>
              {row.side ? (
                <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge>
              ) : null}
              <span className="shrink-0 font-mono text-xs">{row.volume ?? ""}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-2)]">{describeValues(row)}</span>
            </Link>
          ))
        )}
      </div>
    </Card>
  );
}
