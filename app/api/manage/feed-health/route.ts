import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

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
    fetchStats<FeedStatsSnapshot>(`${TRADING_CORE_URL}/internal/feed-stats`),
    fetchStats<GatewayStats>(`${GATEWAY_URL}/internal/gateway-stats`),
  ]);

  return NextResponse.json({ feedStats, gatewayStats });
}
