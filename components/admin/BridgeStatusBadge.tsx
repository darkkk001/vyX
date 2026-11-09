"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { ADMIN_STREAM_RECONNECTED, useAdminEventStream } from "@/lib/admin-realtime";
import { formatDateTime } from "@/lib/format";

// The liquidity bridge's live state (Phase 2.1 A.3, owner 2026-10-23 CONNECTED badge). The server decides the state and
// its words (GET /api/manage/liquidity/status, lib/bridge-status.ts); this only shows them. It is the broker's bridge as
// a whole: the status route names no LP and no connection internals.
//
// Live: refetched on the BridgeStatusChanged event (dealing.bridge_status) and after the event stream reconnects. A
// bridge that stops reporting sends no event (the server turns it Not connected at read time), so it is also re-read
// every 15 s, the bridge's own report interval.

export type BridgeBadgeState = "CONNECTED" | "DEGRADED" | "NOT_CONNECTED";

export type BridgeStatus = {
  badge: BridgeBadgeState;
  text: string;
  since: string | null;
  lastReportAt: string | null;
  licenseExpiresAt: string | null;
};

const POLL_MS = 15_000;

/** The bridge status, kept live. null until the first answer; `failed` when the last read did not succeed. */
export function useBridgeStatus(): { status: BridgeStatus | null; failed: boolean } {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetch("/api/manage/liquidity/status", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`bridge status: ${r.status}`);
        return r.json() as Promise<BridgeStatus>;
      })
      .then((s) => {
        setStatus(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useAdminEventStream((event) => {
    if (event.type === "BridgeStatusChanged" || event.type === ADMIN_STREAM_RECONNECTED) load();
  });

  return { status, failed };
}

/** A bridge that never reported is not set up yet (neutral); one that reported and stopped is a problem (danger). */
export function bridgeTone(s: BridgeStatus): "success" | "warning" | "danger" | "neutral" {
  if (s.badge === "CONNECTED") return "success";
  if (s.badge === "DEGRADED") return "warning";
  return s.lastReportAt ? "danger" : "neutral";
}

/** "since 2026-11-10 14:02:33 UTC" while the state has a start time, else "". */
export function bridgeSince(s: BridgeStatus): string {
  return s.since ? `since ${formatDateTime(s.since)}` : "";
}

/** The badge with its "since" line, for a page header or card. */
export function BridgeStatusBadge({ label = "Liquidity bridge" }: { label?: string }) {
  const { status, failed } = useBridgeStatus();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-[var(--text-3)]">{label}</span>
      {status ? (
        <>
          <Badge tone={bridgeTone(status)}>{status.text}</Badge>
          {bridgeSince(status) ? <span className="text-xs text-[var(--text-3)]">{bridgeSince(status)}</span> : null}
        </>
      ) : (
        <Badge tone="neutral">{failed ? "Status unavailable" : "Checking"}</Badge>
      )}
    </div>
  );
}

const toneColor = {
  success: "var(--buy)",
  warning: "var(--warn)",
  danger: "var(--sell)",
  neutral: "var(--text-3)",
} as const;

/** The dashboard tile: same frame as StatCard, the state in its colour, "since" under it. */
export function BridgeStatusTile() {
  const { status, failed } = useBridgeStatus();
  const tone = status ? bridgeTone(status) : "neutral";
  const value = status ? status.text : failed ? "Status unavailable" : "Checking";
  return (
    <div className="rounded-[11px] border border-[var(--border)] bg-[var(--bg-1)] p-4">
      <p className="mb-2 text-[11px] text-[var(--text-3)]">Liquidity bridge</p>
      <p className="truncate text-[18px] font-bold leading-[28px]" style={{ color: toneColor[tone] }} title={value}>
        {value}
      </p>
      {status && bridgeSince(status) ? <p className="mt-1.5 text-[11px] font-medium text-[var(--text-3)]">{bridgeSince(status)}</p> : null}
    </div>
  );
}
