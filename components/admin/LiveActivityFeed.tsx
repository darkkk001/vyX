"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useAdminEventStream, ADMIN_STREAM_RECONNECTED, type AdminEvent } from "@/lib/admin-realtime";
import { ActivityFeedRows, type ActivityFeedRow } from "./ActivityFeedRows";
import type { DealerActivityAction } from "@/lib/dealer-activity";

const MAX_ROWS = 50;

// Live Exposure's own activity feed (2026-09-04 refinement) -- the WHOLE
// broker's live trade activity: every account's buy/sell, position open/
// close, SL/TP modify, order placed/cancelled/triggered, not just
// DEALING-group accounts (that's the separate, dealer-scoped feed on the
// Dealing page's Activity tab -- DealingDeskPanel.tsx). Named "Live
// activity" rather than anything "dealer"-flavored since this surface is
// platform-wide. Cold-loads its last ~50 from GET /api/manage/live-activity
// (see that route's own doc comment on its disclosed AuditLog backfill
// gaps), then stays live purely off the admin event stream -- no polling.
export default function LiveActivityFeed() {
  const [rows, setRows] = useState<ActivityFeedRow[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function load() {
    return fetch("/api/manage/live-activity")
      .then((r) => r.json())
      .then((d: { rows: ActivityFeedRow[] }) => setRows(d.rows));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  useAdminEventStream((event: AdminEvent) => {
    if (event.type === ADMIN_STREAM_RECONNECTED) {
      load().catch(() => {});
      return;
    }
    // Unlike DealingDeskPanel.tsx, deliberately NOT filtered to
    // is_dealing_group -- every account's activity belongs here.
    if (event.type !== "DealerActivity") return;

    const row: ActivityFeedRow = {
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
    requestAnimationFrame(() => {
      if (scrollRef.current && scrollRef.current.scrollTop < 40) {
        scrollRef.current.scrollTop = 0;
      }
    });
  });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-1)]">Live activity</h3>
          <p className="text-xs text-[var(--text-3)]">Every account&apos;s trading activity across the broker, live.</p>
        </div>
        <span className="text-xs text-[var(--text-3)]">Live · last {MAX_ROWS}</span>
      </div>
      <div ref={scrollRef} className="max-h-[520px] overflow-y-auto">
        {rows === null ? (
          <p className="py-6 text-center text-sm text-[var(--text-3)]">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--text-3)]">No activity yet.</p>
        ) : (
          <ActivityFeedRows rows={rows} showDealingChip />
        )}
      </div>
    </Card>
  );
}
