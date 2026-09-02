"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

// Field names match engine/server's FeedStatsResponse (see
// app/api/manage/feed-health/route.ts's identical comment) -- this copy
// had drifted from the fix/realtime-sync rename until now.
type FeedStatsSnapshot = {
  sample_count: number;
  ea_to_engine_ms_last: number | null;
  ea_to_engine_ms_p50: number | null;
  ea_to_engine_ms_p95: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  ticks_in: number;
  ticks_missing_t0_total: number;
  ticks_dropped_invalid_total: number;
  t0_invalid: number;
  nats_out: number;
  nats_publish_failures_total: number;
  candle_write_failures_total: number;
  db_ok: number;
  db_fail: number;
  db_lag_ms: number;
  mono_to_utc_offset_ms: number | null;
  rtt_ms: number | null;
  queue_len: number;
  per_symbol: PerSymbolStat[];
};

type PerSymbolStat = {
  symbol: string;
  ticks_60s: number;
  last_tick_age_ms: number;
  bid: string;
  ask: string;
};

type GatewayStats = {
  wsConnectionsTotal: number;
  wsDisconnectionsTotal: number;
  ticksForwardedTotal: number;
  natsMessagesReceivedTotal: number;
  // Phase 0 money-risk patch item 3 (docs/ROADMAP.md) -- the Rust/gateway
  // path's own order-ack window (services/api-gateway/src/ws.ts).
  order_ack_ms_p50: number | null;
  order_ack_ms_p95: number | null;
  order_ack_sample_count: number;
};

// Field names match engine/server's alert_stats handler exactly
// (market_data::alerts::AlertMetricsSnapshot) -- see
// app/api/manage/feed-health/route.ts's identical comment.
type AlertStats = {
  active_alerts_total: number;
  triggered_total: number;
  persist_failures_total: number;
  hot_reload_add_total: number;
  hot_reload_cancel_total: number;
  hot_reload_malformed_total: number;
};

// Legacy Next.js/Vercel path's own order-ack window -- see
// app/api/manage/order-latency/route.ts and lib/order-latency.ts's own
// comment on why this one is Redis-backed instead of an in-process array
// like the Rust/gateway path above.
type OrderAckStats = { p50: number | null; p95: number | null; sampleCount: number };

function ms(value: number | null): string {
  return value == null ? "—" : `${value}ms`;
}

// No client component existed for this page at all before -- the Server
// Component ran two internal-service probes directly and rendered
// inline. Self-fetches from a new /api/manage/feed-health GET running
// those same two probes server-side (the internal-service secret header
// can't be sent from the client).
export default function FeedHealthManager() {
  const [data, setData] = useState<{ feedStats: FeedStatsSnapshot | null; gatewayStats: GatewayStats | null; alertStats: AlertStats | null } | null>(null);
  const [orderAck, setOrderAck] = useState<OrderAckStats | null>(null);

  useEffect(() => {
    fetch("/api/manage/feed-health")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ feedStats: null, gatewayStats: null, alertStats: null }));
    fetch("/api/manage/order-latency")
      .then((r) => r.json())
      .then(setOrderAck)
      .catch(() => setOrderAck(null));
  }, []);

  if (data === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  const { feedStats, gatewayStats, alertStats } = data;

  return (
    <>
      <div className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-[var(--text-2)]">Order ack</h2>
        <StatGrid columns={4}>
          <StatCard label="Legacy p50 (Vercel)" value={ms(orderAck?.p50 ?? null)} />
          <StatCard label="Legacy p95 (Vercel)" value={ms(orderAck?.p95 ?? null)} />
          <StatCard label="Rust p50 (gateway)" value={ms(gatewayStats?.order_ack_ms_p50 ?? null)} />
          <StatCard label="Rust p95 (gateway)" value={ms(gatewayStats?.order_ack_ms_p95 ?? null)} />
        </StatGrid>
      </div>

      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-[var(--text-2)]">Rust ingest (engine/server)</h2>
          <Badge tone={feedStats ? "success" : "neutral"}>{feedStats ? "Reachable" : "Not monitored"}</Badge>
        </div>
        {feedStats ? (
          <StatGrid columns={4}>
            <StatCard label="Current latency" value={ms(feedStats.ea_to_engine_ms_last)} />
            <StatCard label="p50" value={ms(feedStats.ea_to_engine_ms_p50)} />
            <StatCard label="p95" value={ms(feedStats.ea_to_engine_ms_p95)} />
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
            <TableCell align="right" mono>{feedStats ? feedStats.ticks_in : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
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
            <TableCell primary>t0 invalid (excluded from latency window)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.t0_invalid : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>NATS published / failures</TableCell>
            <TableCell align="right" mono>{feedStats ? `${feedStats.nats_out} / ${feedStats.nats_publish_failures_total}` : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Candle write failures (background)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.candle_write_failures_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>DB writes ok / failed (lag)</TableCell>
            <TableCell align="right" mono>{feedStats ? `${feedStats.db_ok} / ${feedStats.db_fail} (${feedStats.db_lag_ms}ms)` : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Clock sync (offset / RTT)</TableCell>
            <TableCell align="right" mono>
              {feedStats
                ? feedStats.mono_to_utc_offset_ms == null
                  ? "no handshake yet"
                  : `${feedStats.mono_to_utc_offset_ms}ms / ${feedStats.rtt_ms}ms`
                : <Badge tone="neutral">Not monitored</Badge>}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>Symbols tracked (queue length)</TableCell>
            <TableCell align="right" mono>{feedStats ? feedStats.queue_len : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div className="mb-2 mt-6 flex items-center gap-2">
        <h2 className="text-sm font-medium text-[var(--text-2)]">Price alerts (engine/server)</h2>
        <Badge tone={alertStats ? "success" : "neutral"}>{alertStats ? "Reachable" : "Not monitored"}</Badge>
      </div>
      {alertStats ? (
        <StatGrid columns={4}>
          <StatCard label="Active alerts" value={String(alertStats.active_alerts_total)} />
          <StatCard label="Triggered (since boot)" value={String(alertStats.triggered_total)} />
          <StatCard label="Persist failures" value={String(alertStats.persist_failures_total)} />
          <StatCard label="Hot-reload malformed" value={String(alertStats.hot_reload_malformed_total)} />
        </StatGrid>
      ) : (
        <p className="text-sm text-[var(--text-3)]">engine/server unreachable -- expected until it&apos;s deployed.</p>
      )}
      <Table>
        <TableHead>
          <TableHeaderCell>Counter</TableHeaderCell>
          <TableHeaderCell align="right">Value</TableHeaderCell>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell primary>Hot-reload adds / cancels</TableCell>
            <TableCell align="right" mono>
              {alertStats ? `${alertStats.hot_reload_add_total} / ${alertStats.hot_reload_cancel_total}` : <Badge tone="neutral">Not monitored</Badge>}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell primary>
              Persist failures{" "}
              <span className="font-normal text-[var(--text-3)]">
                (fired in-memory but failed to save -- trader was never notified; resolves on the next full resync)
              </span>
            </TableCell>
            <TableCell align="right" mono>{alertStats ? alertStats.persist_failures_total : <Badge tone="neutral">Not monitored</Badge>}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {feedStats && feedStats.per_symbol.length > 0 ? (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-[var(--text-2)]">Per-symbol freshness (last 60s)</h2>
          <Table>
            <TableHead>
              <TableHeaderCell>Symbol</TableHeaderCell>
              <TableHeaderCell align="right">Ticks (60s)</TableHeaderCell>
              <TableHeaderCell align="right">Last tick age</TableHeaderCell>
              <TableHeaderCell align="right">Bid / Ask</TableHeaderCell>
            </TableHead>
            <TableBody>
              {feedStats.per_symbol.map((s) => (
                <TableRow key={s.symbol}>
                  <TableCell primary mono>{s.symbol}</TableCell>
                  <TableCell align="right" mono>{s.ticks_60s}</TableCell>
                  <TableCell align="right" mono>{ms(s.last_tick_age_ms)}</TableCell>
                  <TableCell align="right" mono>{s.bid} / {s.ask}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

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
