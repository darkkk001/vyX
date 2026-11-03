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

// Express middleware -- keys by accountId (set by requireTraderSession,
// so this must run after it) rather than IP, since a trader's own
// order-placement rate is what matters here, not their network address.
export function rateLimitOrders(limit: number, windowSeconds: number) {
  return async (req: import("./auth.js").AuthedRequest, res: import("express").Response, next: import("express").NextFunction) => {
    const accountId = req.session?.accountId;
    if (!accountId) {
      // requireTraderSession should always run first and already 401'd
      // if there's no session -- this is just a defensive fallback.
      next();
      return;
    }
    const { allowed, remaining } = checkRateLimitLocal(`order:${accountId}`, limit, windowSeconds);
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!allowed) {
      res.status(429).json({ error: "too many order requests, slow down" });
      return;
    }
    next();
  };
}
