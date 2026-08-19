import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

type FeedStatsSnapshot = {
  sample_count: number;
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

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

// Same "attempt a real check, only fall back to Not monitored on actual
// failure" convention as the Super Admin Platform Health page
// (app/(super-admin)/(shell)/health/page.tsx) -- neither engine/server
// nor services/api-gateway has a public deployment yet (Tick Pipeline
// Audit), so both fetches are expected to fail everywhere except a local
// dev stack right now. A short timeout keeps this page from hanging the
// whole Manager shell load waiting on an unreachable host.
async function fetchStats<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      headers: { "x-internal-secret": INTERNAL_SERVICE_SECRET },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function ms(value: number | null): string {
  return value == null ? "—" : `${value}ms`;
}

// BROKER_ADMIN + MANAGER: same operational-visibility pair as
// Positions/Dealing queue, not the finance/ops RISK_SETTINGS carve-out --
// this is read-only infrastructure health, nothing to delegate/restrict.
export default async function ManagerFeedHealthPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }

  const [feedStats, gatewayStats] = await Promise.all([
    fetchStats<FeedStatsSnapshot>(`${TRADING_CORE_URL}/internal/feed-stats`),
    fetchStats<GatewayStats>(`${GATEWAY_URL}/internal/gateway-stats`),
  ]);

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader
        title="Feed health"
        description="Tick-pipeline latency and health, end to end. Not deployed publicly yet -- see the Tick Pipeline Audit -- so this shows real numbers only against a local dev stack."
      />

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
          <p className="text-sm text-[var(--text-3)]">
            engine/server unreachable at <span className="font-mono">{TRADING_CORE_URL}</span> -- expected until it&apos;s deployed.
          </p>
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
    </main>
  );
}
