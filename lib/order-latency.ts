import "server-only";
import { getRedis } from "@/lib/redis";

// Phase 0 money-risk patch (docs/ROADMAP.md item 3) -- "we will never
// again ship an order path we can't measure." This is the legacy
// Next.js/Vercel path's half of that; the Rust/gateway path's own
// order-ack window lives in services/api-gateway/src/ws.ts's
// gatewayStats (a genuinely long-running process, so a plain in-memory
// array works there). This route runs as a Vercel serverless function --
// no shared memory across invocations/cold starts -- so the rolling
// window has to live somewhere external. Redis (already used for trader
// sessions, never authoritative for money, see lib/redis.ts's own
// comment) is the right-sized tool for an ephemeral metrics window,
// not a new Postgres table for data nobody needs to keep forever.
// Same capped-window + sorted-percentile algorithm as
// engine/market-data/src/stats.rs's FeedStats, just backed by a Redis
// list (LPUSH/LTRIM) instead of an in-process VecDeque.
const WINDOW = 500;

function keyFor(brokerId: string): string {
  return `order_ack_ms:${brokerId}`;
}

export async function recordOrderAckLatency(brokerId: string, ms: number): Promise<void> {
  const redis = getRedis();
  const key = keyFor(brokerId);
  await redis.lpush(key, ms);
  await redis.ltrim(key, 0, WINDOW - 1);
}

export type OrderAckStats = { p50: number | null; p95: number | null; sampleCount: number };

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[idx];
}

export async function getOrderAckStats(brokerId: string): Promise<OrderAckStats> {
  const raw = await getRedis().lrange(keyFor(brokerId), 0, -1);
  const sorted = raw.map(Number).sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), sampleCount: sorted.length };
}
