// Fixed-window counter, same shape as lib/rate-limit.ts's Next.js
// equivalent (already live on /api/trade/login) -- mirrored rather than
// imported since this is a separately-installed npm package (see
// db.ts's own doc comment on the same constraint), reusing the same
// Redis instance auth.ts already connects to.

import { getRedis } from "./auth.js";

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  const redisKey = `ratelimit:gw:${key}`;
  // L2 optimization pass: ONE round trip, not two. The INCR and the window's EXPIRE used to be two
  // awaited calls, so the first request of every window paid an extra 17 ms to Upstash (measured:
  // PING p50 16.9 ms from this VPS). `EXPIRE ... NX` sets the TTL only when the key has none, which is
  // exactly what `if (count === 1)` meant -- same fixed-window semantics, half the round trips.
  const [[, count]] = (await redis
    .multi()
    .incr(redisKey)
    .expire(redisKey, windowSeconds, "NX")
    .exec()) as [[Error | null, number], [Error | null, number]];
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

// L2 optimization pass: the gateway's order limiter runs IN PROCESS.
//
// Why that is sound here: this bucket only ever governed orders arriving at THIS gateway, keyed by
// account. There is one gateway process, so a per-process fixed window enforces the identical rule,
// and the web's own order limiter (lib/order-rate-limit.ts, a different store) is untouched -- no
// shared budget is being widened.
//
// What it gives up: the counter resets if the gateway restarts, so an account could get a fresh window
// early. Against a 30-orders-per-minute bucket whose purpose is to stop a runaway client, that is an
// acceptable trade for removing a 17 ms Upstash round trip from in front of every order.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimitLocal(key: string, limit: number, windowSeconds: number): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: 1 <= limit, remaining: Math.max(0, limit - 1) };
  }
  b.count += 1;
  if (buckets.size > 4096) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count) };
}

// REFUSALS ARE COUNTED, AND SAID OUT LOUD.
//
// Before this, a 429 left no trace anywhere: no log line, no counter. Asked "how many orders did the
// limiter refuse in the last 20 minutes", the honest answer was "unknowable" -- `grep 429 gateway.log`
// returns nothing because nothing was ever written, which reads like "none happened" and is not the same
// claim. A refused order is the limiter doing its job, but it is also a trader seeing a rejection, so it
// belongs in the log and in /internal/gateway-stats like every other thing we measure.
//
// Keyed by BUCKET, not by account: the per-account identity is already in the log line, and a per-account
// counter map would grow without bound. Counters are process-local and reset with the process, the same
// trade checkRateLimitLocal already makes.
const rejections = new Map<string, number>();

/**
 * Count one refusal against `bucket`. Exported because the per-IP edge limiter (edge-rate-limit.ts)
 * refuses requests too, by calling checkRateLimitLocal directly rather than going through
 * rateLimitOrders -- so without this it would be a second 429 source that reports nothing, which is the
 * exact blind spot this accounting was added to remove. One counter, every refusal, whoever refused it.
 */
export function countRateLimitRejection(bucket: string): void {
  rejections.set(bucket, (rejections.get(bucket) ?? 0) + 1);
}

/** 429 counts for /internal/gateway-stats: a total, plus one entry per bucket ("order", "close", ...). */
export function rateLimitStats(): { rateLimited: { total: number; byBucket: Record<string, number> } } {
  const byBucket: Record<string, number> = {};
  let total = 0;
  for (const [bucket, n] of rejections) {
    byBucket[bucket] = n;
    total += n;
  }
  return { rateLimited: { total, byBucket } };
}

// Express middleware -- keys by accountId (set by requireTraderSession,
// so this must run after it) rather than IP, since a trader's own
// order-placement rate is what matters here, not their network address.
//
// `bucket` names the budget. It defaults to "order" so every existing call site keeps the exact key it
// had (`order:<accountId>`), and a different name buys a SEPARATE allowance -- which is the point for
// closes: see routes/positions.ts. Two call sites sharing a bucket share one budget, so opens stealing
// from closes is a choice of bucket name, not an accident of mounting order.
export function rateLimitOrders(limit: number, windowSeconds: number, bucket = "order") {
  return async (req: import("./auth.js").AuthedRequest, res: import("express").Response, next: import("express").NextFunction) => {
    const accountId = req.session?.accountId;
    if (!accountId) {
      // requireTraderSession should always run first and already 401'd
      // if there's no session -- this is just a defensive fallback.
      next();
      return;
    }
    const { allowed, remaining } = checkRateLimitLocal(`${bucket}:${accountId}`, limit, windowSeconds);
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!allowed) {
      countRateLimitRejection(bucket);
      console.warn(
        `[rate-limit] 429 bucket=${bucket} account=${accountId} limit=${limit}/${windowSeconds}s path=${req.method} ${req.originalUrl}`
      );
      res.status(429).json({ error: "too many order requests, slow down" });
      return;
    }
    next();
  };
}
