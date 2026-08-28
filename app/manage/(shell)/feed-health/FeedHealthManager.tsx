"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

type FeedStatsSnapshot = {
  current_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  ticks_ingested_total: number;
  ticks_missing_t0_total: number;
  ticks_dropped_invalid_total: number;
  nats_publish_failures_total: number;
  candle_write_failures_total: number;
};

type GatewayStats = {
  wsConnectionsTotal: number;
  wsDisconnectionsTotal: number;
  ticksForwardedTotal: number;
  natsMessagesReceivedTotal: number;
};

function ms(value: number | null): string {
  return value == null ? "—" : `${value}ms`;
}

// No client component existed for this page at all before -- the Server
// Component ran two internal-service probes directly and rendered
// inline. Self-fetches from a new /api/manage/feed-health GET running
// those same two probes server-side (the internal-service secret header
// can't be sent from the client).
export default function FeedHealthManager() {
  const [data, setData] = useState<{ feedStats: FeedStatsSnapshot | null; gatewayStats: GatewayStats | null } | null>(null);

  useEffect(() => {
    fetch("/api/manage/feed-health")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ feedStats: null, gatewayStats: null }));
  }, []);

  if (data === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  const { feedStats, gatewayStats } = data;

  return (
    <>
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-[var(--text-2)]">Rust ingest (engine/server)</h2>
          <Badge tone={feedStats ? "success" : "neutral"}>{feedStats ? "Reachable" : "Not monitored"}</Badge>
        </div>
        {feedStats ? (
          <StatGrid columns={4}>
            <StatCard label="Current latency" value={ms(feedStats.current_ms)} />
            <StatCard label="p50" value={ms(feedStats.p50_ms)} />
            <StatCard label="p95" value={ms(feedStats.p95_ms)} />
            <StatCard label="p99 / max" value={`${ms(feedStats.p99_ms)} / ${ms(feedStats.max_ms)}`} />
          </StatGrid>
        ) : (
          <p className="text-sm text-[var(--text-3)]">engine/server unreachable -- expected until it&apos;s deployed.</p>
        )}
      </div>

      <Table>
        <TableHead>
          <TableHeaderCell>Counter</TableHeaderCell>
          <TableHeaderCell align="right">Value</TableHeaderCell>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell primary>Ticks ingested (rolling)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.ticks_ingested_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Ticks missing origin timestamp</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.ticks_missing_t0_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Ticks dropped (invalid)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.ticks_dropped_invalid_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>NATS publish failures</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.nats_publish_failures_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Candle write failures (background)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.candle_write_failures_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div className="mb-2 mt-6 flex items-center gap-2">
        <h2 className="text-sm font-medium text-[var(--text-2)]">WebSocket gateway (services/api-gateway)</h2>
        <Badge tone={gatewayStats ? "success" : "neutral"}>{gatewayStats ? "Reachable" : "Not monitored"}</Badge>
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell>Counter</TableHeaderCell>
          <TableHeaderCell align="right">Value</TableHeaderCell>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell primary>Client connections (total)</TableCell>
            <TableCell align="right" mono>{gatewayStats ? gatewayStats.wsConnectionsTotal : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Client disconnects/reconnects (total)</TableCell>
            <TableCell align="right" mono>{gatewayStats ? gatewayStats.wsDisconnectionsTotal : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>NATS messages received</TableCell>
            <TableCell align="right" mono>{gatewayStats ? gatewayStats.natsMessagesReceivedTotal : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Ticks forwarded to clients</TableCell>
            <TableCell align="right" mono>{gatewayStats ? gatewayStats.ticksForwardedTotal : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </>
  );
}
