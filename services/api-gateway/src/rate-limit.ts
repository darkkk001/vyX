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
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
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
    const { allowed, remaining } = await checkRateLimit(`order:${accountId}`, limit, windowSeconds);
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!allowed) {
      res.status(429).json({ error: "too many order requests -- slow down" });
      return;
    }
    next();
  };
}
