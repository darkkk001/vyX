"use client";

import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { bridgeSince, bridgeTone, useBridgeStatus, type BridgeConsoleView } from "@/components/admin/BridgeStatusBadge";
import { formatDateTime } from "@/lib/format";

// Phase 2.1 #4: the liquidity bridge's status console, at the top of the Liquidity page. The badge (unchanged words and
// rules) heads the card; under it, what the bridge's v2 report says (qorebridge docs/bridge-status-report.md): overall
// health, the license, intents held and why, and one row per LP lane. The server joins the LP names (the bridge sends ids).
// A FIX 4.4 / netting LP always reports 0 open positions, so the console shows in-flight and delivered, never positions;
// "Delivered" is completedSinceStart, the hedge orders completed since the bridge started.

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

const LANE_TEXT: Record<string, { text: string; tone: Tone }> = {
  ready: { text: "Ready", tone: "success" },
  connecting: { text: "Connecting", tone: "warning" },
  reconciling: { text: "Checking orders", tone: "warning" },
  disconnected: { text: "Disconnected", tone: "danger" },
  logging_out: { text: "Logging out", tone: "neutral" },
  maintenance: { text: "LP maintenance", tone: "info" },
  market_closed: { text: "Market closed", tone: "info" },
  halted: { text: "Halted", tone: "danger" },
  auth_halted: { text: "Login refused", tone: "danger" },
  stopped: { text: "Stopped", tone: "neutral" },
  unknown: { text: "Unknown", tone: "neutral" },
};

const HOLD_TEXT: Record<string, string> = {
  market_closed: "Market closed",
  lp_reconnecting: "LP reconnecting",
  no_lp_up: "No LP available",
  db_error: "Waiting for the platform",
  lane_stopped: "Lane stopped",
  license_suspended: "License suspended",
};

const HEALTH: Record<string, { text: string; color: string }> = {
  ok: { text: "Healthy", color: "var(--buy)" },
  degraded: { text: "Degraded", color: "var(--warn)" },
  down: { text: "Down", color: "var(--sell)" },
};

/** The license line, in plain words: "Active", "Grace period" (sub: "until 2026-11-12 09:00:00 UTC"), "Suspended: billing". */
export function licenseText(l: BridgeConsoleView["license"]): { text: string; color: string; sub?: string } {
  switch (l.state) {
    case "active":
      return { text: "Active", color: "var(--buy)" };
    case "grace":
      return { text: "Grace period", color: "var(--warn)", sub: l.graceUntil ? `until ${formatDateTime(new Date(l.graceUntil))}` : "platform not reachable" };
    case "suspended":
      return { text: l.reason ? `Suspended: ${l.reason}` : "Suspended", color: "var(--sell)" };
    case "stopped":
      return { text: l.reason ? `Stopped: ${l.reason}` : "Stopped", color: "var(--sell)" };
    case "holding":
      return { text: "Holding", color: "var(--warn)" };
    default:
      return { text: "Unknown", color: "var(--text-3)" };
  }
}

function Stat({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-[9px] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{label}</p>
      <p className="mt-1 truncate text-[15px] font-semibold" style={{ color: color ?? "var(--text-1)" }} title={value}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-[var(--text-3)]">{sub}</p> : null}
    </div>
  );
}

const n = (v: number) => v.toLocaleString("en-US");

export function BridgeConsoleBody({ console: c, stoppedReporting }: { console: BridgeConsoleView | null; stoppedReporting: boolean }) {
  if (!c) {
    return (
      <p className="text-sm text-[var(--text-3)]">
        {stoppedReporting ? "The bridge has stopped reporting, so there is no detailed status." : "Detailed status not reported yet."}
      </p>
    );
  }
  const health = HEALTH[c.health] ?? { text: c.health, color: "var(--text-1)" };
  const lic = licenseText(c.license);
  const ready = c.lanes.filter((l) => l.state === "ready").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Overall health" value={health.text} color={health.color} />
        <Stat label="License" value={lic.text} color={lic.color} sub={lic.sub} />
        <Stat label="Held orders" value={n(c.held.total)} color={c.held.total > 0 ? "var(--warn)" : undefined} sub="waiting for an LP" />
        <Stat label="LP lanes ready" value={c.hedging ? `${ready} of ${c.lanes.length}` : "No hedging"} color={c.hedging && ready < c.lanes.length ? "var(--warn)" : undefined} />
      </div>

      <div>
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Held by reason</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(HOLD_TEXT).map(([k, label]) => {
            const v = c.held.byReason[k as keyof typeof c.held.byReason] ?? 0;
            return (
              <span
                key={k}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] ${v > 0 ? "border-[var(--warn)] text-[var(--warn)]" : "border-[var(--border)] text-[var(--text-3)]"}`}
              >
                {label}
                <span className="font-semibold tabular-nums">{n(v)}</span>
              </span>
            );
          })}
        </div>
      </div>

      <Table>
        <TableHead>
          <TableHeaderCell>Liquidity provider</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell>
          <TableHeaderCell align="right" title="Hedge orders sent to the LP and not finished yet">In flight</TableHeaderCell>
          <TableHeaderCell align="right" title="Hedge orders completed since the bridge started">Delivered</TableHeaderCell>
          <TableHeaderCell align="right" title="Logins the LP refused since the bridge started">Logon rejects</TableHeaderCell>
          <TableHeaderCell align="right" title="LP-side refusals and drops during maintenance since the bridge started">Maintenance refusals</TableHeaderCell>
        </TableHead>
        <TableBody>
          {c.lanes.length === 0 ? (
            <TableEmptyState colSpan={6}>{c.hedging ? "No LP lanes reported." : "No hedging is configured on this bridge."}</TableEmptyState>
          ) : (
            c.lanes.map((l) => {
              const s = LANE_TEXT[l.state] ?? LANE_TEXT.unknown;
              return (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.name ?? <span className="text-[var(--text-3)]">Unknown LP</span>}
                    {l.name ? null : <span className="ml-1.5 font-mono text-[11px] text-[var(--text-3)]">{l.id.slice(0, 10)}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge tone={s.tone}>{s.text}</Badge>
                  </TableCell>
                  <TableCell align="right" mono>{n(l.inFlight)}</TableCell>
                  <TableCell align="right" mono>{n(l.completedSinceStart)}</TableCell>
                  <TableCell align="right" mono>{n(l.logonRejects)}</TableCell>
                  <TableCell align="right" mono>{n(l.maintenanceRefusals)}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <p className="text-[11px] text-[var(--text-3)]">
        Last report {formatDateTime(c.reportedAt)}. Counts run from the bridge&apos;s last start.
      </p>
    </div>
  );
}

/** The Liquidity page's bridge card: the badge in the header, the console under it. One status read for both. */
export function BridgeStatusConsole() {
  const { status, failed } = useBridgeStatus();
  const badge = status ? (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={bridgeTone(status)}>{status.text}</Badge>
      {bridgeSince(status) ? <span className="text-xs text-[var(--text-3)]">{bridgeSince(status)}</span> : null}
    </div>
  ) : (
    <Badge tone="neutral">{failed ? "Status unavailable" : "Checking"}</Badge>
  );
  return (
    <Card title="Liquidity bridge" action={badge}>
      {status ? (
        <BridgeConsoleBody console={status.console ?? null} stoppedReporting={status.badge === "NOT_CONNECTED" && !!status.lastReportAt} />
      ) : (
        <p className="text-sm text-[var(--text-3)]">{failed ? "Could not read the bridge status." : "Checking"}</p>
      )}
    </Card>
  );
}
