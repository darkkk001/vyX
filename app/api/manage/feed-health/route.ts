import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Field names match engine/server's FeedStatsResponse exactly (the
// #[serde(flatten)] FeedStatsSnapshot plus queue_len/per_symbol) --
// engine/market-data/src/stats.rs renamed current_ms/p50_ms/p95_ms to
// ea_to_engine_ms_{last,p50,p95}, ticks_ingested_total to ticks_in, and
// added t0_invalid/nats_out/db_ok/db_fail/db_lag_ms/
// mono_to_utc_offset_ms/rtt_ms during fix/realtime-sync -- this type
// (and FeedHealthManager.tsx's own copy) had drifted from that rename
// until now, silently rendering 4 fields blank.
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
};

type PerSymbolStat = {
  symbol: string;
  ticks_60s: number;
  last_tick_age_ms: number;
  bid: string;
  ask: string;
};

type FeedStatsResponse = FeedStatsSnapshot & {
  queue_len: number;
  per_symbol: PerSymbolStat[];
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

// Same two internal-service probes app/manage/(shell)/feed-health/page.tsx's
// Server Component used to run inline -- exposed as JSON so a new
// FeedHealthManager.tsx can self-fetch it. Must stay server-side: the
// INTERNAL_SERVICE_SECRET header can't be sent from a browser/webview
// without leaking it into client-visible network requests.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [feedStats, gatewayStats] = await Promise.all([
    fetchStats<FeedStatsResponse>(`${TRADING_CORE_URL}/internal/feed-stats`),
    fetchStats<GatewayStats>(`${GATEWAY_URL}/internal/gateway-stats`),
  ]);

  return NextResponse.json({ feedStats, gatewayStats });
}
