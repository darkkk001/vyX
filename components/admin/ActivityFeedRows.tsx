"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/format";
import type { DealerActivityAction } from "@/lib/dealer-activity";

export type ActivityFeedRow = {
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

export const ACTIVITY_ACTION_LABEL: Record<DealerActivityAction, string> = {
  ORDER_PLACED: "Order placed",
  ORDER_MODIFIED: "SL/TP modified",
  ORDER_CANCELLED: "Order cancelled",
  ORDER_TRIGGERED: "Pending order triggered",
  POSITION_OPENED: "Position opened",
  POSITION_CLOSED: "Position closed",
};

// The only color per row now lives here, on the action label itself
// (2026-09-04 styling fix -- see this file's own module comment below for
// what this replaced). "warning"/"danger" read correctly in both themes
// via Badge's own token-based tones (--warn/--sell), not a hardcoded hex.
export const ACTIVITY_ACTION_TONE: Record<DealerActivityAction, "accent" | "warning" | "danger" | "success" | "neutral"> = {
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

export function describeActivityValues(row: ActivityFeedRow): string {
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

// Shared row list for both activity-feed surfaces (Live Exposure's
// LiveActivityFeed.tsx and the Dealing page's DealingDeskPanel.tsx) --
// one place to keep them visually identical, and the fix point for a
// real styling complaint (2026-09-04): each row used to carry a heavy
// per-row amber border + background glow
// (`border border-amber-500/40 bg-amber-500/10` on every single row),
// which read as loud/cluttered and didn't actually mean anything on the
// Dealing page (where every row is dealing-group by definition, so it
// was just permanently-on noise). Color now lives ONLY on the action
// label's own Badge -- rows themselves are separated by a plain thin
// divider, matching every other backoffice table.
//
// showDealingChip: Live Exposure shows every account mixed together, so
// a small chip flags which rows are on a manually-managed account; the
// Dealing page's own feed is already 100% dealing-group-scoped, where
// that same chip on every row would just be redundant noise -- caller
// decides per its own scope, not inferred from the data.
export function ActivityFeedRows({ rows, showDealingChip = false }: { rows: ActivityFeedRow[]; showDealingChip?: boolean }) {
  return (
    <div className="flex flex-col divide-y divide-[var(--border)]">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/manage/accounts/${row.accountId}`}
          className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-2)]"
        >
          <span className="w-[110px] shrink-0 text-xs text-[var(--text-3)]">{formatDateTime(row.at)}</span>
          <span className="flex w-[130px] shrink-0 items-center gap-1.5 font-mono text-xs text-[var(--text-1)]">
            {row.accountNumber}
            {showDealingChip && row.isDealingGroup ? (
              <span className="rounded border border-[var(--border)] px-1 py-px text-[9px] font-medium uppercase leading-tight tracking-wide text-[var(--text-3)]">
                Dealing
              </span>
            ) : null}
          </span>
          <Badge tone={ACTIVITY_ACTION_TONE[row.action]}>{ACTIVITY_ACTION_LABEL[row.action]}</Badge>
          <span className="w-[70px] shrink-0 font-mono text-xs">{row.symbol ?? "—"}</span>
          {row.side ? <Badge tone={row.side === "BUY" ? "success" : "danger"}>{row.side}</Badge> : null}
          <span className="shrink-0 font-mono text-xs">{row.volume ?? ""}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-2)]">{describeActivityValues(row)}</span>
        </Link>
      ))}
    </div>
  );
}
